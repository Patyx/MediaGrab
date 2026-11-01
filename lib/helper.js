// Bridge to the MediaGrab Helper (Windows native messaging host, see /helper).
// One long-lived port serialises file saves; every yt-dlp job gets its own port
// (= its own helper process) so a long download never blocks other saves.

const HOST = 'com.mediagrab.helper';
const CHUNK = 4 * 1024 * 1024; // raw bytes per message (~5.3 MB as base64)

class HelperPort {
  constructor() {
    this.pending = new Map();
    this.alive = true;
    this.port = chrome.runtime.connectNative(HOST);
    this.port.onMessage.addListener((m) => {
      const p = this.pending.get(m?.rid);
      if (!p) return;
      if (m.event === 'progress') return p.onProgress?.(m);
      this.pending.delete(m.rid);
      if (m.event === 'error') p.reject(new Error(m.error || 'helper error'));
      else p.resolve(m);
    });
    this.port.onDisconnect.addListener(() => {
      this.alive = false;
      const err = new Error(chrome.runtime.lastError?.message || 'MediaGrab Helper closed unexpectedly');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }
  call(msg, onProgress) {
    if (!this.alive) return Promise.reject(new Error('MediaGrab Helper is not running'));
    return new Promise((resolve, reject) => {
      const rid = crypto.randomUUID();
      this.pending.set(rid, { resolve, reject, onProgress });
      // Key order matters for save-chunk: the helper parses cmd, rid, id, data positionally.
      this.port.postMessage({ cmd: msg.cmd, rid, ...msg });
    });
  }
  close() {
    this.alive = false;
    try { this.port.disconnect(); } catch {}
  }
}

// One-shot command on its own helper process.
async function once(msg, onProgress) {
  const port = new HelperPort();
  try {
    return await port.call(msg, onProgress);
  } finally {
    port.close();
  }
}

// Oldest helper with every command this extension uses (compression arrived in 1.4.0).
export const MIN_HELPER = '1.5.0';
export const helperOutdated = (v) => {
  const a = String(v || '0').split('.').map(Number), b = MIN_HELPER.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
};

const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms));

// Status is cached in session storage so service-worker restarts don't re-launch the
// helper for every popup open. `full` also asks for the yt-dlp version (slower).
const STATUS_TTL = 10 * 60e3;
let statusMem = null;
let statusInflight = null;
export async function helperStatus(force = false, full = false) {
  if (!force) {
    if (statusMem && Date.now() - statusMem.at < STATUS_TTL) return statusMem.data;
    try {
      const { helperStatus: s } = await chrome.storage.session.get('helperStatus');
      if (s && Date.now() - s.at < STATUS_TTL) { statusMem = s; return s.data; }
    } catch {}
    if (statusInflight) return statusInflight;
  }
  statusInflight = (async () => {
    let data;
    const p = new HelperPort();
    try {
      const r = await Promise.race([p.call({ cmd: 'hello', full }), timeout(15000, 'Helper check')]);
      data = { installed: true, version: r.version, ytdlp: r.ytdlp || (r.hasYtdlp ? 'installed' : null), ffmpeg: !!r.ffmpeg, deno: !!r.deno };
    } catch (e) {
      data = { installed: false, error: /not found|forbidden/i.test(e.message) ? 'not installed' : e.message };
    } finally {
      p.close();
    }
    statusMem = { at: Date.now(), data };
    chrome.storage.session.set({ helperStatus: statusMem }).catch(() => {});
    return data;
  })().finally(() => { statusInflight = null; });
  return statusInflight;
}

// ---------------------------------------------------------------- saving

let savePort = null;
const getSavePort = () => (savePort?.alive ? savePort : (savePort = new HelperPort()));
let saveChain = Promise.resolve();
const queue = (fn) => {
  const run = saveChain.then(fn, fn);
  saveChain = run.catch(() => {});
  return run;
};

// "Download all" groups: first file gets the dialog, the rest follow into its folder.
const groups = new Map(); // group id -> folder | 'cancelled'
export const dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
const groupDir = (group) => {
  const d = group && groups.get(group);
  if (d === 'cancelled') throw new Error('cancelled');
  return d || null;
};
const rememberGroup = (group, path) => { if (group && !groups.get(group)) groups.set(group, dirname(path)); };

function toBase64(u8) {
  if (typeof u8.toBase64 === 'function') return u8.toBase64(); // native (recent Chrome), much faster
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// Saves the file at `url` (blob: or https:) through the helper's Save dialog.
// convert: 'mp3' converts the (M4A) audio with ffmpeg before it lands.
// stage: keep the file under a temporary name next to the chosen path (for compression).
// Returns { path, size, staged }.
export function helperSave({ url, name, ext, group, convert = null, stage = false, mp3Quality = '0', onProgress }) {
  return queue(async () => {
    groupDir(group);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const port = getSavePort();
    const id = crypto.randomUUID();
    const begin = await port.call({ cmd: 'save-begin', id, name, ext, dir: groupDir(group), convert, stage });
    if (begin.event === 'cancelled') {
      if (group) groups.set(group, 'cancelled');
      throw new Error('cancelled');
    }
    rememberGroup(group, begin.path);
    try {
      for (let o = 0; o < bytes.length; o += CHUNK) {
        await port.call({ cmd: 'save-chunk', id, data: toBase64(bytes.subarray(o, o + CHUNK)) });
        onProgress?.(Math.min(100, Math.round(((o + CHUNK) / bytes.length) * 100)));
      }
      const done = await port.call({ cmd: 'save-end', id, mp3Quality });
      return { path: done.path, size: done.size ?? bytes.length, staged: done.staged || null };
    } catch (e) {
      port.call({ cmd: 'save-abort', id }).catch(() => {});
      throw e;
    }
  });
}

// ---------------------------------------------------------------- yt-dlp

// opts: { url, name?, infoFile?, ext, audio, mp3Quality, maxHeight, resFirst, preferH264, cookies,
//         playlistItem, group, makeName(info) -> string, onProgress(pct) }. Returns { path, size }.
export async function ytdlpDownload(opts) {
  const port = new HelperPort();
  try {
    let { name } = opts;
    let infoFile = opts.infoFile || null;
    if (!name) {
      const info = await port.call({ cmd: 'ytdlp-info', url: opts.url, cookies: opts.cookies, playlistItem: opts.playlistItem || null });
      name = opts.makeName(info);
      infoFile = info.infoFile || null;
    }
    const r = await port.call({
      cmd: 'ytdlp-download',
      url: opts.url,
      name,
      ext: opts.ext,
      dir: groupDir(opts.group),
      infoFile,
      cookies: opts.cookies,
      audio: opts.audio || null,
      mp3Quality: opts.mp3Quality,
      maxHeight: opts.maxHeight || 0,
      preferH264: !!opts.preferH264,
      resFirst: !!opts.resFirst,
      playlistItem: opts.playlistItem || null,
    }, (ev) => opts.onProgress?.(ev.pct));
    if (r.event === 'cancelled') {
      if (opts.group) groups.set(opts.group, 'cancelled');
      throw new Error('cancelled');
    }
    rememberGroup(opts.group, r.path);
    return { path: r.path, size: r.size ?? null };
  } finally {
    port.close();
  }
}

// Extracts a page once: metadata, the video qualities on offer (short side, e.g. 1080),
// and an info file the download can reuse instead of extracting again.
export async function ytdlpProbe(url, cookies) {
  const info = await once({ cmd: 'ytdlp-info', url, cookies, playlistItem: null });
  const parse = (s) => { try { return JSON.parse(s || '[]') || []; } catch { return []; } };
  const w = parse(info.widths), h = parse(info.heights), vc = parse(info.vcodecs), ac = parse(info.acodecs);
  const fs = parse(info.filesizes), ap = parse(info.approx), vb = parse(info.vbrs), ab = parse(info.abrs), tb = parse(info.tbrs);
  const dur = Number(info.duration) || 0;
  const hasAudio = (i) => ac[i] && ac[i] !== 'none';
  const bytesOf = (i) => fs[i] || ap[i] || Math.round((tb[i] || vb[i] || ab[i] || 0) * 125 * dur) || 0;
  // Best separate audio track (added to video-only formats).
  let audio = -1;
  vc.forEach((v, i) => { if (v === 'none' && hasAudio(i) && (audio < 0 || (ab[i] || tb[i] || 0) > (ab[audio] || tb[audio] || 0))) audio = i; });
  // Per quality (short side): the highest-bitrate video format, with an estimated total size.
  const estimates = {};
  h.forEach((hh, i) => {
    if (!hh || !vc[i] || vc[i] === 'none') return;
    const q = w[i] ? Math.min(w[i], hh) : hh;
    const vkbps = vb[i] || (hasAudio(i) ? (tb[i] || 0) - (ab[i] || 0) : tb[i]) || 0;
    const bytes = bytesOf(i) + (hasAudio(i) || audio < 0 ? 0 : bytesOf(audio));
    if (!estimates[q] || vkbps > estimates[q].vkbps) estimates[q] = { vkbps: Math.round(vkbps), bytes, w: w[i], h: hh };
  });
  const qualities = Object.keys(estimates).map(Number).sort((a, b) => b - a);
  return { info, qualities, estimates };
}

// Re-encode a saved video to HEVC (see Invoke-Compress in the helper). Returns the helper's
// result: { path, size, origSize, outcome: 'compressed'|'kept'|'under-limit'|'failed', ... }.
export const helperCompress = (opts, onProgress) => once({ cmd: 'compress', ...opts }, (ev) => onProgress?.(ev));
export const helperEncoders = (force = false) => once({ cmd: 'encoders', force }).then((r) => r.encoders);

export const helperOpenFolder = (path) => once({ cmd: 'open-folder', path: path || null });
export const helperOpenFile = (path) => once({ cmd: 'open-file', path });
export const ytdlpUpdate = () => once({ cmd: 'ytdlp-update' });

// Cookies for the URL's site in Netscape format (what yt-dlp --cookies expects).
export async function cookiesFor(url) {
  try {
    const host = new URL(url).hostname;
    const domain = host.split('.').slice(-2).join('.');
    const list = await chrome.cookies.getAll({ domain });
    if (!list.length) return null;
    const lines = list.map((c) => [
      c.hostOnly ? c.domain : c.domain.startsWith('.') ? c.domain : '.' + c.domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0),
      c.name,
      c.value,
    ].join('\t'));
    return `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`;
  } catch {
    return null;
  }
}
