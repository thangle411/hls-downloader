// Minimal ISO-BMFF (MP4) helpers for rewriting fragmented-MP4 output from an
// HLS playlist into a standalone fragmented MP4, one fragment at a time.

const u32 = (u8, o) => ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];
const set32 = (u8, o, v) => new DataView(u8.buffer, u8.byteOffset).setUint32(o, v);
const fourcc = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

// Boxes in u8[start, end), non-recursive.
function parseBoxes(u8, start = 0, end = u8.byteLength) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) throw new Error(`Malformed MP4 box at byte ${o}`);
    boxes.push({ type: fourcc(u8, o + 4), start: o, end: o + size, body: o + header });
    o += size;
  }
  return boxes;
}

const childBoxes = (u8, box) => parseBoxes(u8, box.body, box.end);
const findChild = (u8, box, type) => childBoxes(u8, box).find((b) => b.type === type);
function findPath(u8, box, ...types) {
  for (const t of types) box = box && findChild(u8, box, t);
  return box;
}

function makeBox(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  set32(out, 0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function concatBytes(...parts) {
  return makeBox("xxxx", ...parts).subarray(8);
}

// Offset of a full box's field that sits after creation/modification times.
const afterTimes = (u8, box) => box.body + 4 + (u8[box.body] === 1 ? 16 : 8);

// Zero the duration field of mvhd/tkhd/mdhd; it sits `gap` bytes after the times.
function clearDuration(u8, box, gap) {
  const o = afterTimes(u8, box) + gap;
  u8.fill(0, o, o + (u8[box.body] === 1 ? 8 : 4));
}

function parseInit(init) {
  const top = parseBoxes(init);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("Init segment has no moov box");

  const mvhd = findChild(init, moov, "mvhd");
  const trex = new Map();
  const mvex = findChild(init, moov, "mvex");
  if (mvex) {
    for (const b of childBoxes(init, mvex)) {
      if (b.type === "trex") trex.set(u32(init, b.body + 4), init.slice(b.start, b.end));
    }
  }

  const tracks = [];
  for (const trak of childBoxes(init, moov)) {
    if (trak.type !== "trak") continue;
    const tkhd = findChild(init, trak, "tkhd");
    const mdhd = findPath(init, trak, "mdia", "mdhd");
    const hdlr = findPath(init, trak, "mdia", "hdlr");
    const id = u32(init, afterTimes(init, tkhd));
    tracks.push({
      id,
      timescale: u32(init, afterTimes(init, mdhd)),
      handler: fourcc(init, hdlr.body + 8),
      trak: init.slice(trak.start, trak.end),
      trex: trex.get(id),
    });
  }
  return {
    ftyp: ftyp && init.slice(ftyp.start, ftyp.end),
    mvhd: init.slice(mvhd.start, mvhd.end),
    timescale: u32(init, afterTimes(init, mvhd)),
    tracks,
  };
}

// Combined ftyp + moov for all tracks. Each track needs `outId` assigned.
function buildInit(inits, tracks, durationSec) {
  const first = inits[0];
  const ftyp =
    first.ftyp || makeBox("ftyp", new TextEncoder().encode("isom"), new Uint8Array([0, 0, 2, 0]), new TextEncoder().encode("isomiso6mp41"));

  const mvhd = first.mvhd.slice();
  set32(mvhd, mvhd.byteLength - 4, tracks.length + 1); // next_track_ID
  clearDuration(mvhd, parseBoxes(mvhd)[0], 4);

  // Durations in moov are zeroed: the real one goes in mehd. (mux.js writes
  // 0xFFFFFFFF here, which players read as a ~13 hour video.)
  const traks = tracks.map((t) => {
    const trak = t.trak.slice();
    const box = parseBoxes(trak)[0];
    const tkhd = findChild(trak, box, "tkhd");
    set32(trak, afterTimes(trak, tkhd), t.outId);
    clearDuration(trak, tkhd, 8);
    clearDuration(trak, findPath(trak, box, "mdia", "mdhd"), 4);
    return trak;
  });

  const trexes = tracks.map((t) => {
    if (t.trex) {
      const trex = t.trex.slice();
      set32(trex, 12, t.outId);
      return trex;
    }
    const body = new Uint8Array(24);
    set32(body, 4, t.outId);
    set32(body, 8, 1); // default_sample_description_index
    return makeBox("trex", body);
  });

  // mehd lets players show the full duration without scanning the file.
  const mehd = new Uint8Array(12);
  mehd[0] = 1;
  new DataView(mehd.buffer).setBigUint64(4, BigInt(Math.round(durationSec * first.timescale)));

  const moov = makeBox("moov", mvhd, ...traks, makeBox("mvex", makeBox("mehd", mehd), ...trexes));
  return concatBytes(ftyp, moov);
}

// Split fragmented-MP4 media into fragments: each moof plus everything up to its last mdat.
// sidx/styp and other boxes between fragments are dropped (their offsets would be wrong).
function splitFragments(u8) {
  const boxes = parseBoxes(u8);
  const frags = [];
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== "moof") continue;
    let last = -1;
    let j = i + 1;
    for (; j < boxes.length && boxes[j].type !== "moof"; j++) if (boxes[j].type === "mdat") last = j;
    if (last < 0) throw new Error("moof without mdat");
    frags.push(u8.slice(boxes[i].start, boxes[last].end));
    i = j - 1;
  }
  return frags;
}

// Locate the fields we rewrite in a fragment. `trackMap` maps source track IDs to output tracks.
function describeFragment(frag, trackMap) {
  const moof = parseBoxes(frag)[0];
  const mfhd = findChild(frag, moof, "mfhd");
  const trafs = [];
  let time = Infinity;
  for (const traf of childBoxes(frag, moof)) {
    if (traf.type !== "traf") continue;
    const tfhd = findChild(frag, traf, "tfhd");
    if (frag[tfhd.body + 3] & 0x01) throw new Error("Fragments with absolute base-data-offset are not supported");
    const track = trackMap.get(u32(frag, tfhd.body + 4));
    if (!track) throw new Error(`Fragment references unknown track ${u32(frag, tfhd.body + 4)}`);
    const tfdt = findChild(frag, traf, "tfdt");
    if (!tfdt) throw new Error("Fragment has no tfdt (decode time)");
    const v1 = frag[tfdt.body] === 1;
    const pos = tfdt.body + 4;
    const decodeTime = v1 ? Number(new DataView(frag.buffer, frag.byteOffset).getBigUint64(pos)) : u32(frag, pos);
    trafs.push({ idPos: tfhd.body + 4, tfdtPos: pos, v1, decodeTime, track });
    time = Math.min(time, decodeTime / track.timescale);
  }
  return { bytes: frag, seqPos: mfhd.body + 4, trafs, time };
}

// Rewrite sequence number, track IDs and decode times (shifted so the file starts at 0).
function finalizeFragment(f, seq) {
  set32(f.bytes, f.seqPos, seq);
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset);
  for (const t of f.trafs) {
    set32(f.bytes, t.idPos, t.track.outId);
    const v = Math.max(0, t.decodeTime - t.track.shift);
    if (t.v1) dv.setBigUint64(t.tfdtPos, BigInt(v));
    else dv.setUint32(t.tfdtPos, v);
  }
  return f.bytes;
}
