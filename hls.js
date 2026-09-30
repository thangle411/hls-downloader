// Minimal HLS playlist parser shared by the popup and the downloader page.

function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith("#EXTM3U")) throw new Error("Not an HLS playlist");

  const resolve = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [];
    const audio = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttrs(line.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith("#")) j++;
        if (j < lines.length) {
          variants.push({
            url: resolve(lines[j]),
            bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
            resolution: a.RESOLUTION || "",
            height: a.RESOLUTION ? parseInt(a.RESOLUTION.split("x")[1], 10) : 0,
            codecs: a.CODECS || "",
            audioGroup: a.AUDIO || "",
          });
        }
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        const a = parseAttrs(line.slice(13));
        if (a.TYPE === "AUDIO" && a.URI) {
          audio.push({ url: resolve(a.URI), group: a["GROUP-ID"], name: a.NAME, lang: a.LANGUAGE, isDefault: a.DEFAULT === "YES" });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants, audio };
  }

  // Media playlist
  const segments = [];
  let mediaSequence = 0;
  let key = null;
  let map = null;
  let duration = 0;
  let pendingDur = 0;
  let byteRange = null;
  let lastRangeEnd = 0;
  let isLive = true;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD === "NONE" ? null : { method: a.METHOD, uri: a.URI ? resolve(a.URI) : null, iv: a.IV || null };
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      map = { url: resolve(a.URI), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith("#EXTINF:")) {
      pendingDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      byteRange = parseRange(line.slice(17), lastRangeEnd);
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      isLive = false;
    } else if (!line.startsWith("#")) {
      const seg = {
        url: resolve(line),
        duration: pendingDur,
        seq: mediaSequence + segments.length,
        key,
        map,
        range: byteRange,
      };
      if (byteRange) lastRangeEnd = byteRange.end + 1;
      segments.push(seg);
      duration += pendingDur;
      pendingDur = 0;
      byteRange = null;
    }
  }

  return { type: "media", segments, duration, isLive, isFmp4: segments.some((s) => s.map) };
}

// "length[@offset]" -> { start, end } (inclusive)
function parseRange(str, defaultStart) {
  const [len, off] = str.split("@");
  const start = off !== undefined ? parseInt(off, 10) : defaultStart;
  return { start, end: start + parseInt(len, 10) - 1 };
}

function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}

function formatBytes(n) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function safeFilename(name) {
  return (name || "video").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "video";
}
