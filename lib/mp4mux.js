// Minimal ISO-BMFF (MP4) remuxer.
//
// Takes the video track from one MP4 and the audio track from another (fragmented
// DASH/CMAF files as served by Reddit and Instagram, or regular MP4s) and writes a
// single regular "faststart" MP4 (ftyp, moov, mdat) containing both. Samples are
// copied byte-for-byte: nothing is re-encoded, so quality is untouched and it's fast.

const MOVIE_TIMESCALE = 1000;
const CHUNK_SECONDS = 0.5; // interleave audio/video in ~0.5 s chunks

export function muxAV(videoBytes, audioBytes) {
  const v = parseMp4(videoBytes);
  const a = parseMp4(audioBytes);
  const vt = v.tracks.find((t) => t.handler === 'vide' && t.samples.length);
  const at = a.tracks.find((t) => t.handler === 'soun' && t.samples.length);
  if (!vt) throw new Error('no video samples found');
  if (!at) throw new Error('no audio samples found');
  return writeMp4([
    { track: vt, src: videoBytes, movieTimescale: v.movieTimescale },
    { track: at, src: audioBytes, movieTimescale: a.movieTimescale },
  ]);
}

// Video from videoBytes plus audio from audioBytes, or from videoBytes itself when
// audioBytes is null (a stream that already carries both tracks).
export function remux(videoBytes, audioBytes) {
  if (audioBytes) return muxAV(videoBytes, audioBytes);
  const v = parseMp4(videoBytes);
  const vt = v.tracks.find((t) => t.handler === 'vide' && t.samples.length);
  if (!vt) throw new Error('no video samples found');
  const at = v.tracks.find((t) => t.handler === 'soun' && t.samples.length);
  return writeMp4([vt, at].filter(Boolean).map((track) => ({ track, src: videoBytes, movieTimescale: v.movieTimescale })));
}

// Copy just the audio track into an .m4a (no re-encoding).
export function extractAudio(bytes) {
  const p = parseMp4(bytes);
  const at = p.tracks.find((t) => t.handler === 'soun' && t.samples.length);
  if (!at) throw new Error('this video has no audio track');
  return writeMp4([{ track: at, src: bytes, movieTimescale: p.movieTimescale }], { audioOnly: true });
}

// ---------------------------------------------------------------- reading

class Reader {
  constructor(u8) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  u16(p) { return this.dv.getUint16(p); }
  u32(p) { return this.dv.getUint32(p); }
  i32(p) { return this.dv.getInt32(p); }
  u64(p) { return Number(this.dv.getBigUint64(p)); }
  i64(p) { return Number(this.dv.getBigInt64(p)); }
  fourcc(p) {
    const u = this.u8;
    return String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
  }
  list(start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = this.u32(p);
      const type = this.fourcc(p + 4);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = this.u64(p + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr) break;
      out.push({ type, start: p, data: p + hdr, end: Math.min(p + size, end) });
      p += size;
    }
    return out;
  }
  kids(box, type) {
    if (!box) return [];
    const l = this.list(box.data, box.end);
    return type ? l.filter((b) => b.type === type) : l;
  }
  kid(box, type) { return this.kids(box, type)[0]; }
  path(box, ...types) {
    for (const t of types) box = this.kid(box, t);
    return box;
  }
}

export function parseMp4(u8) {
  const r = new Reader(u8);
  const top = r.list(0, u8.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('not an MP4 (no moov box)');

  const mvhd = r.kid(moov, 'mvhd');
  const movieTimescale = r.u32(mvhd.data + (u8[mvhd.data] === 1 ? 20 : 12));

  const trex = new Map();
  for (const t of r.kids(r.kid(moov, 'mvex'), 'trex')) {
    const p = t.data + 4;
    trex.set(r.u32(p), { dur: r.u32(p + 8), size: r.u32(p + 12), flags: r.u32(p + 16) });
  }

  const tracks = new Map();
  for (const trak of r.kids(moov, 'trak')) {
    const tkhd = r.kid(trak, 'tkhd');
    const id = r.u32(tkhd.data + (u8[tkhd.data] === 1 ? 20 : 12));
    const mdia = r.kid(trak, 'mdia');
    const mdhd = r.kid(mdia, 'mdhd');
    const v1 = u8[mdhd.data] === 1;
    const hdlr = r.kid(mdia, 'hdlr');
    const stbl = r.path(mdia, 'minf', 'stbl');
    const stsd = r.kid(stbl, 'stsd');
    tracks.set(id, {
      id,
      handler: r.fourcc(hdlr.data + 8),
      width: r.u32(tkhd.end - 8) / 65536,
      height: r.u32(tkhd.end - 4) / 65536,
      timescale: r.u32(mdhd.data + (v1 ? 20 : 12)),
      language: r.u16(mdhd.data + (v1 ? 32 : 20)),
      stsd: u8.slice(stsd.start, stsd.end),
      edits: parseElst(r, r.path(trak, 'edts', 'elst')),
      samples: parseStbl(r, stbl),
      startTime: null,
      trex: trex.get(id) || { dur: 0, size: 0, flags: 0 },
    });
  }

  for (const b of top) if (b.type === 'moof') parseMoof(r, b, tracks);

  // Drop samples that point past the end of the file (truncated download).
  for (const t of tracks.values()) {
    const bad = t.samples.findIndex((s) => s.offset + s.size > u8.length);
    if (bad >= 0) t.samples.length = bad;
  }
  return { movieTimescale, tracks: [...tracks.values()] };
}

function parseElst(r, b) {
  if (!b) return null;
  const v1 = r.u8[b.data] === 1;
  const n = r.u32(b.data + 4);
  const out = [];
  let p = b.data + 8;
  for (let i = 0; i < n; i++) {
    if (v1) { out.push({ dur: r.u64(p), mediaTime: r.i64(p + 8) }); p += 20; }
    else { out.push({ dur: r.u32(p), mediaTime: r.i32(p + 4) }); p += 12; }
  }
  return out;
}

// Regular (non-fragmented) sample tables.
function parseStbl(r, stbl) {
  const stsz = r.kid(stbl, 'stsz');
  if (!stsz) return [];
  const fixed = r.u32(stsz.data + 4);
  const count = r.u32(stsz.data + 8);
  if (!count) return [];

  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || r.u32(stsz.data + 12 + i * 4);

  const durs = new Array(count).fill(0);
  const stts = r.kid(stbl, 'stts');
  if (stts) {
    let k = 0;
    const n = r.u32(stts.data + 4);
    for (let e = 0, p = stts.data + 8; e < n; e++, p += 8) {
      const c = r.u32(p), d = r.u32(p + 4);
      for (let j = 0; j < c && k < count; j++) durs[k++] = d;
    }
  }

  const ctos = new Array(count).fill(0);
  const ctts = r.kid(stbl, 'ctts');
  if (ctts) {
    let k = 0;
    const n = r.u32(ctts.data + 4);
    for (let e = 0, p = ctts.data + 8; e < n; e++, p += 8) {
      const c = r.u32(p), o = r.i32(p + 4);
      for (let j = 0; j < c && k < count; j++) ctos[k++] = o;
    }
  }

  let sync = null;
  const stss = r.kid(stbl, 'stss');
  if (stss) {
    sync = new Set();
    const n = r.u32(stss.data + 4);
    for (let i = 0; i < n; i++) sync.add(r.u32(stss.data + 8 + i * 4));
  }

  const chunkOffsets = [];
  const stco = r.kid(stbl, 'stco');
  const co64 = r.kid(stbl, 'co64');
  if (stco) for (let i = 0, n = r.u32(stco.data + 4); i < n; i++) chunkOffsets.push(r.u32(stco.data + 8 + i * 4));
  else if (co64) for (let i = 0, n = r.u32(co64.data + 4); i < n; i++) chunkOffsets.push(r.u64(co64.data + 8 + i * 8));

  const stscBox = r.kid(stbl, 'stsc');
  const stsc = [];
  if (stscBox) {
    const n = r.u32(stscBox.data + 4);
    for (let i = 0, p = stscBox.data + 8; i < n; i++, p += 12) stsc.push({ first: r.u32(p), spc: r.u32(p + 4) });
  }

  const samples = [];
  let k = 0, e = 0;
  for (let ci = 0; ci < chunkOffsets.length && k < count && stsc.length; ci++) {
    while (e + 1 < stsc.length && stsc[e + 1].first <= ci + 1) e++;
    let off = chunkOffsets[ci];
    for (let j = 0; j < stsc[e].spc && k < count; j++, k++) {
      samples.push({ offset: off, size: sizes[k], dur: durs[k], cto: ctos[k], sync: !sync || sync.has(k + 1) });
      off += sizes[k];
    }
  }
  return samples;
}

// Fragmented MP4: moof/traf/trun.
function parseMoof(r, moof, tracks) {
  for (const traf of r.kids(moof, 'traf')) {
    const tfhd = r.kid(traf, 'tfhd');
    if (!tfhd) continue;
    const flags = r.u32(tfhd.data) & 0xffffff;
    let p = tfhd.data + 4;
    const t = tracks.get(r.u32(p));
    p += 4;
    if (!t) continue;

    let base = moof.start; // default-base-is-moof (and the usual single-traf case)
    if (flags & 0x1) { base = r.u64(p); p += 8; }
    if (flags & 0x2) p += 4;
    let defDur = t.trex.dur, defSize = t.trex.size, defFlags = t.trex.flags;
    if (flags & 0x8) { defDur = r.u32(p); p += 4; }
    if (flags & 0x10) { defSize = r.u32(p); p += 4; }
    if (flags & 0x20) { defFlags = r.u32(p); p += 4; }

    const tfdt = r.kid(traf, 'tfdt');
    if (tfdt && t.startTime === null) {
      t.startTime = r.u8[tfdt.data] === 1 ? r.u64(tfdt.data + 4) : r.u32(tfdt.data + 4);
    }

    let cursor = base;
    for (const trun of r.kids(traf, 'trun')) {
      const tf = r.u32(trun.data) & 0xffffff;
      const n = r.u32(trun.data + 4);
      let q = trun.data + 8;
      let off = cursor;
      if (tf & 0x1) { off = base + r.i32(q); q += 4; }
      let firstFlags = null;
      if (tf & 0x4) { firstFlags = r.u32(q); q += 4; }
      for (let i = 0; i < n; i++) {
        let dur = defDur, size = defSize, cto = 0;
        let sf = i === 0 && firstFlags !== null ? firstFlags : defFlags;
        if (tf & 0x100) { dur = r.u32(q); q += 4; }
        if (tf & 0x200) { size = r.u32(q); q += 4; }
        if (tf & 0x400) { sf = r.u32(q); q += 4; }
        if (tf & 0x800) { cto = r.i32(q); q += 4; }
        t.samples.push({ offset: off, size, dur, cto, sync: ((sf >>> 16) & 1) === 0 });
        off += size;
      }
      cursor = off;
    }
  }
}

// ---------------------------------------------------------------- writing

const te = new TextEncoder();
const EMPTY = new Uint8Array(0);
const ascii = (s) => te.encode(s);
const zeros = (n) => new Uint8Array(n);
const num = (bytes, set) => (v) => {
  const b = new Uint8Array(bytes);
  set(new DataView(b.buffer), v);
  return b;
};
const u16 = num(2, (d, v) => d.setUint16(0, v));
const u32 = num(4, (d, v) => d.setUint32(0, v >>> 0));
const u64 = num(8, (d, v) => d.setBigUint64(0, BigInt(v)));

function cat(...parts) {
  const flat = parts.flat(Infinity);
  let n = 0;
  for (const p of flat) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...parts) {
  const body = cat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}
function fbox(type, version, flags, ...parts) {
  return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), parts);
}
function table(n, width, fill) {
  const b = new Uint8Array(n * width);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) fill(dv, i * width, i);
  return b;
}
function runs(vals) {
  const out = [];
  for (const v of vals) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}
const MATRIX = cat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));

function prepareTrack({ track: t, src, movieTimescale }, index) {
  const mediaDur = t.samples.reduce((a, s) => a + s.dur, 0);
  const toMovie = (d, ts) => Math.round((d * MOVIE_TIMESCALE) / ts);

  // Rebuild the edit list in our movie timescale: keep a leading gap (tfdt start or an
  // empty edit) and the media start offset (B-frame / AAC priming compensation).
  const edits = [];
  if (t.startTime > 0) edits.push({ dur: toMovie(t.startTime, t.timescale), mediaTime: -1 });
  let mediaStart = 0;
  for (const e of t.edits || []) {
    if (e.mediaTime < 0) {
      if (e.dur > 0) edits.push({ dur: toMovie(e.dur, movieTimescale), mediaTime: -1 });
      continue;
    }
    mediaStart = e.mediaTime;
    break;
  }
  if (edits.length || mediaStart) {
    edits.push({ dur: Math.max(0, toMovie(mediaDur - mediaStart, t.timescale)), mediaTime: mediaStart });
  }
  const movieDur = edits.length ? edits.reduce((a, e) => a + e.dur, 0) : toMovie(mediaDur, t.timescale);

  let { width, height } = t;
  if (t.handler === 'vide' && (!width || !height) && t.stsd.length >= 52) {
    // Visual sample entry: width/height live 32 bytes into the first entry.
    const dv = new DataView(t.stsd.buffer, t.stsd.byteOffset, t.stsd.byteLength);
    width = dv.getUint16(48);
    height = dv.getUint16(50);
  }
  return { ...t, index, src, mediaDur, edits, movieDur, width, height, chunks: [] };
}

function trakBox(t, base, useCo64) {
  const isVideo = t.handler === 'vide';
  const isAudio = t.handler === 'soun';
  const s = t.samples;
  const n = s.length;

  const tkhd = fbox('tkhd', 0, 3,
    u32(0), u32(0), u32(t.index + 1), u32(0), u32(t.movieDur),
    zeros(8), u16(0), u16(0), u16(isAudio ? 0x0100 : 0), u16(0), MATRIX,
    u32(Math.round(t.width * 65536)), u32(Math.round(t.height * 65536)));

  const edts = t.edits.length
    ? box('edts', fbox('elst', 0, 0, u32(t.edits.length), table(t.edits.length, 12, (dv, o, i) => {
        dv.setUint32(o, t.edits[i].dur);
        dv.setInt32(o + 4, t.edits[i].mediaTime);
        dv.setUint16(o + 8, 1);
      })))
    : EMPTY;

  const mdhd = t.mediaDur > 0xffffffff
    ? fbox('mdhd', 1, 0, u64(0), u64(0), u32(t.timescale), u64(t.mediaDur), u16(t.language), u16(0))
    : fbox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(t.mediaDur), u16(t.language), u16(0));
  const hdlr = fbox('hdlr', 0, 0, u32(0), ascii(t.handler), zeros(12),
    ascii(isVideo ? 'VideoHandler' : isAudio ? 'SoundHandler' : 'Handler'), zeros(1));
  const mhd = isVideo ? fbox('vmhd', 0, 1, zeros(8)) : isAudio ? fbox('smhd', 0, 0, zeros(4)) : fbox('nmhd', 0, 0);
  const dinf = box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1)));

  const stts = runs(s.map((x) => x.dur));
  const sttsBox = fbox('stts', 0, 0, u32(stts.length), table(stts.length, 8, (dv, o, i) => {
    dv.setUint32(o, stts[i][0]);
    dv.setUint32(o + 4, stts[i][1]);
  }));

  let cttsBox = EMPTY;
  if (s.some((x) => x.cto)) {
    const c = runs(s.map((x) => x.cto));
    const negative = s.some((x) => x.cto < 0);
    cttsBox = fbox('ctts', negative ? 1 : 0, 0, u32(c.length), table(c.length, 8, (dv, o, i) => {
      dv.setUint32(o, c[i][0]);
      dv.setInt32(o + 4, c[i][1]);
    }));
  }

  let stssBox = EMPTY;
  if (isVideo) {
    const sync = [];
    s.forEach((x, i) => x.sync && sync.push(i + 1));
    if (sync.length && sync.length < n) {
      stssBox = fbox('stss', 0, 0, u32(sync.length), table(sync.length, 4, (dv, o, i) => dv.setUint32(o, sync[i])));
    }
  }

  const stscRuns = [];
  t.chunks.forEach((c, i) => {
    const last = stscRuns[stscRuns.length - 1];
    if (!last || last[1] !== c.count) stscRuns.push([i + 1, c.count]);
  });
  const stsc = fbox('stsc', 0, 0, u32(stscRuns.length), table(stscRuns.length, 12, (dv, o, i) => {
    dv.setUint32(o, stscRuns[i][0]);
    dv.setUint32(o + 4, stscRuns[i][1]);
    dv.setUint32(o + 8, 1);
  }));
  const stsz = fbox('stsz', 0, 0, u32(0), u32(n), table(n, 4, (dv, o, i) => dv.setUint32(o, s[i].size)));
  const nc = t.chunks.length;
  const stco = useCo64
    ? fbox('co64', 0, 0, u32(nc), table(nc, 8, (dv, o, i) => dv.setBigUint64(o, BigInt(base + t.chunks[i].pos))))
    : fbox('stco', 0, 0, u32(nc), table(nc, 4, (dv, o, i) => dv.setUint32(o, base + t.chunks[i].pos)));

  const stbl = box('stbl', t.stsd, sttsBox, cttsBox, stssBox, stsc, stsz, stco);
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stbl)));
}

export function writeMp4(inputs, { audioOnly = false } = {}) {
  const tracks = inputs.map(prepareTrack);

  // Group samples into ~0.5 s chunks per track, then interleave chunks by time.
  const chunks = [];
  for (const t of tracks) {
    const s = t.samples;
    const limit = CHUNK_SECONDS * t.timescale;
    let i = 0, dts = 0;
    while (i < s.length) {
      const c = { t, first: i, count: 0, size: 0, time: dts / t.timescale, pos: 0 };
      let d = 0;
      do { d += s[i].dur; c.size += s[i].size; c.count++; i++; } while (i < s.length && d < limit);
      dts += d;
      chunks.push(c);
    }
  }
  chunks.sort((a, b) => a.time - b.time || a.t.index - b.t.index);

  let payload = 0;
  for (const c of chunks) { c.pos = payload; payload += c.size; c.t.chunks.push(c); }

  // Sample data: reference slices of the input buffers, merging contiguous runs.
  const ranges = [];
  let cur = null;
  for (const c of chunks) {
    const { src, samples } = c.t;
    for (let k = c.first; k < c.first + c.count; k++) {
      const s = samples[k];
      if (cur && cur.src === src && cur.end === s.offset) cur.end += s.size;
      else { cur = { src, start: s.offset, end: s.offset + s.size }; ranges.push(cur); }
    }
  }

  const bigMdat = payload + 8 > 0xffffffff;
  const useCo64 = payload > 0xffffffff - 64 * 1024 * 1024;
  const mdatHdr = bigMdat ? cat(u32(1), ascii('mdat'), u64(payload + 16)) : cat(u32(payload + 8), ascii('mdat'));
  const ftyp = audioOnly
    ? box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'))
    : box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  const movieDur = Math.max(...tracks.map((t) => t.movieDur));

  const moov = (base) => box('moov',
    fbox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDur), u32(0x00010000), u16(0x0100),
      zeros(10), MATRIX, zeros(24), u32(tracks.length + 1)),
    tracks.map((t) => trakBox(t, base, useCo64)));

  // moov size doesn't depend on the offset values (fixed-width fields), so measure first.
  const base = ftyp.length + moov(0).length + mdatHdr.length;
  return new Blob(
    [ftyp, moov(base), mdatHdr, ...ranges.map((r) => r.src.subarray(r.start, r.end))],
    { type: audioOnly ? 'audio/mp4' : 'video/mp4' },
  );
}
