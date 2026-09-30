// Download engine. Fetches the segments of one HLS media playlist with bounded
// concurrency and writes one output file incrementally, so memory stays flat no
// matter how big the video is.
//
// Output is a fragmented MP4 (or the original segments if they can't be
// remuxed). Streams with a separate audio playlist use two HlsDownloads, one
// per file, instead of interleaving both tracks into a single MP4.

class HlsDownload {
  constructor({ url, label = "video", signal, log = () => {}, concurrency = 6 }) {
    this.url = url;
    this.label = label;
    this.signal = signal;
    this.log = log;
    this.concurrency = concurrency;
    this.lookahead = concurrency * 2; // max segments fetched ahead of what's been written
    this.bytesDownloaded = 0;
    this.bytesWritten = 0;
    this.keys = new Map();
    this.inits = new Map();
  }

  // Load the playlist and probe the first segment.
  async prepare() {
    this.playlist = await this.loadMediaPlaylist(this.url);
    this.total = this.playlist.segments.length;
    await this.probe();

    this.raw = !this.init;
    if (this.raw) this.log(`${this.label}: can't convert to MP4 in the browser; saving the original segments instead (plays in VLC).`);
    else this.trackMap = new Map(this.init.tracks.map((t, i) => [t.id, Object.assign(t, { outId: i + 1 })]));

    this.duration = this.playlist.duration;
    this.estimatedBytes = (this.probeBytes / (this.playlist.segments[0].duration || 1)) * this.playlist.duration;
    return { ext: this.ext(), estimatedBytes: this.estimatedBytes, duration: this.duration };
  }

  hasAudio() {
    return !!this.init?.tracks.some((t) => t.handler === "soun");
  }

  hasVideo() {
    return !!this.init?.tracks.some((t) => t.handler === "vide");
  }

  ext() {
    if (!this.raw) return this.hasVideo() ? "mp4" : "m4a";
    const m = this.playlist.segments[0].url.split("?")[0].match(/\.(aac|mp3|ac3|ec3)$/i);
    return m ? m[1].toLowerCase() : "ts";
  }

  // Timestamp (seconds) of the first sample in the stream.
  startTime() {
    return this.raw ? null : describeFragment(this.probeFrag, this.trackMap).time;
  }

  // Shift timestamps so `start` (seconds) becomes 0. Pass the same value to the
  // video and audio downloads to keep their relative offset.
  setStart(start) {
    if (this.raw) return;
    for (const t of this.trackMap.values()) t.shift = Math.round(start * t.timescale);
    this.startSet = true;
  }

  async loadMediaPlaylist(url) {
    let p = parsePlaylist(await fetchWithRetry(url, { as: "text", signal: this.signal }), url);
    if (p.type === "master") {
      // Opened directly on a master playlist: pick the highest quality.
      url = p.variants[0].url;
      p = parsePlaylist(await fetchWithRetry(url, { as: "text", signal: this.signal }), url);
    }
    if (!p.segments.length) throw new Error("Playlist has no segments");
    const drm = p.segments.find((s) => s.key && s.key.method !== "AES-128");
    if (drm) throw new Error(`Encryption "${drm.key.method}" is DRM-protected and can't be downloaded`);
    if (p.isLive) this.log(`${this.label}: live stream, only the segments currently in the playlist will be saved.`);
    return p;
  }

  async probe() {
    const seg = await this.fetchSegment(0);
    this.probeBytes = seg.data.byteLength;
    try {
      const fr = this.makeFragmenter();
      const frags = fr.push(seg).flatMap(splitFragments);
      if (!frags.length || !fr.init) throw new Error("no MP4 output");
      this.init = parseInit(fr.init);
      this.probeFrag = frags[0];
      this.log(`${this.label}: ${this.total} segments, ${this.playlist.isFmp4 ? "fMP4" : "MPEG-TS"}${this.playlist.segments[0].key ? ", AES-128" : ""}`);
    } catch (e) {
      this.log(`${this.label}: can't remux (${e.message})`);
      this.init = null;
    }
  }

  // Turns downloaded segments into fragmented-MP4 chunks.
  makeFragmenter() {
    if (this.playlist.isFmp4) {
      return {
        init: null,
        push({ data, init }) {
          if (!this.init) this.init = new Uint8Array(init);
          return [new Uint8Array(data)];
        },
      };
    }
    // MPEG-TS / packed audio -> fMP4 via mux.js. Original timestamps are kept so
    // separate audio and video files share a timeline; we shift them ourselves.
    const tm = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    const fr = { init: null, out: [] };
    tm.on("data", (s) => {
      if (!fr.init) fr.init = new Uint8Array(s.initSegment);
      fr.out.push(new Uint8Array(s.data));
    });
    fr.push = ({ data }) => {
      tm.push(new Uint8Array(data));
      tm.flush();
      return fr.out.splice(0);
    };
    return fr;
  }

  async fetchSegment(i) {
    const seg = this.playlist.segments[i];
    let data = await fetchWithRetry(seg.url, { range: seg.range, signal: this.signal });
    if (seg.key) data = await this.decrypt(data, seg);
    let init = null;
    if (seg.map) {
      const k = seg.map.url + JSON.stringify(seg.map.range);
      if (!this.inits.has(k)) this.inits.set(k, fetchWithRetry(seg.map.url, { range: seg.map.range, signal: this.signal }));
      init = await this.inits.get(k);
    }
    this.bytesDownloaded += data.byteLength;
    return { data, init };
  }

  async decrypt(data, seg) {
    const { uri, iv } = seg.key;
    if (!this.keys.has(uri)) {
      this.keys.set(
        uri,
        fetchWithRetry(uri, { signal: this.signal }).then((raw) => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]))
      );
    }
    const ivBytes = new Uint8Array(16);
    if (iv) {
      const hex = iv.replace(/^0x/i, "").padStart(32, "0");
      for (let i = 0; i < 16; i++) ivBytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      // Default IV is the media sequence number as a 128-bit big-endian integer.
      new DataView(ivBytes.buffer).setUint32(12, seg.seq);
    }
    return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, await this.keys.get(uri), data);
  }

  // output: { write(Uint8Array): Promise }. onProgress({ done, total, ... }).
  async run(output, onProgress = () => {}) {
    const fragmenter = this.makeFragmenter();
    const results = new Array(this.total);
    let flushed = 0;
    let seq = 0;

    if (!this.raw) {
      if (!this.startSet) this.setStart(this.startTime());
      await this.write(output, buildInit([this.init], [...this.trackMap.values()], this.duration));
    }

    // Write every segment that's ready, in playlist order.
    const flush = async () => {
      while (flushed < this.total && results[flushed]) {
        const r = results[flushed];
        results[flushed++] = null;
        if (this.raw) {
          await this.write(output, new Uint8Array(r.data));
        } else {
          for (const chunk of fragmenter.push(r)) {
            for (const f of splitFragments(chunk)) await this.write(output, finalizeFragment(describeFragment(f, this.trackMap), ++seq));
          }
        }
      }
    };

    let nextJob = 0;
    let waiters = [];
    let flushing = Promise.resolve();
    const started = Date.now();

    const worker = async () => {
      while (nextJob < this.total) {
        if (this.signal?.aborted) throw new Error("Cancelled");
        if (nextJob - flushed >= this.lookahead) {
          await new Promise((r) => waiters.push(r));
          continue;
        }
        const i = nextJob++;
        results[i] = await this.fetchSegment(i);
        // Serialize writes; awaiting here gives backpressure when the disk is slow.
        flushing = flushing.then(flush);
        await flushing;
        waiters.splice(0).forEach((r) => r());
        const secs = (Date.now() - started) / 1000;
        onProgress({
          done: flushed,
          total: this.total,
          bytesDownloaded: this.bytesDownloaded,
          bytesWritten: this.bytesWritten,
          speed: this.bytesDownloaded / secs,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, this.total) }, worker));
    await flushing.then(flush);
  }

  async write(output, bytes) {
    await output.write(bytes);
    this.bytesWritten += bytes.byteLength;
  }
}
