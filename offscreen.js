// Offscreen document: resolves sources (applying quality preferences), fetches bytes,
// merges DASH/HLS video+audio or extracts audio, and hands a blob: URL back to the
// service worker (which owns chrome.downloads).
import { remux, extractAudio } from './lib/mp4mux.js';
import { parseDash, chooseReps } from './lib/dash.js';
import { parseMaster, parseMedia } from './lib/hls.js';
import { pickVideo, pickAudio, res } from './lib/pick.js';

const send = (msg) => chrome.runtime.sendMessage({ to: 'sw', ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  if (msg.type === 'MG_ABORT') { controllers.get(msg.jobId)?.abort(); sendResponse({ ok: true }); return; }
  if (msg.type === 'MG_SIZE') {
    itemSize(msg.item, msg.prefs || {}).then(
      (data) => sendResponse({ ok: true, data }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
    );
    return true;
  }
  if (msg.type === 'MG_JOB') runJob(msg.jobId, msg.item, msg.prefs || {}, msg.mode, msg.name, msg.compress);
  else if (msg.type === 'MG_REVOKE') URL.revokeObjectURL(msg.url);
  sendResponse({ ok: true });
});

const EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif',
};

// Running jobs' abort handles (the popup's red ✕).
const controllers = new Map();

async function runJob(jobId, item, prefs, mode, name, compress = null) {
  const ids = { jobId, key: item.key, mode, name, compress };
  const ctl = new AbortController();
  const sig = ctl.signal;
  controllers.set(jobId, ctl);
  try {
    const plan = await resolve(item.source, prefs);
    const progress = makeProgress(ids, plan.video && plan.audio && mode !== 'audio' ? 2 : 1);
    let blob;
    let ext = plan.ext || 'mp4';
    let warning = '';

    if (mode === 'audio') {
      const r = await getBytes(plan.audio || plan.video || plan.single, progress(0), false, sig);
      send({ type: 'MG_JOB_PROGRESS', ...ids, state: 'merging', pct: 100 });
      blob = extractAudio(r.bytes);
      ext = 'm4a';
    } else if (plan.video) {
      const [v, a] = await Promise.all([
        getBytes(plan.video, progress(0), false, sig),
        plan.audio ? getBytes(plan.audio, progress(1), true, sig) : null,
      ]);
      if (plan.audio && !a) warning = 'no audio track found, saved without sound';
      send({ type: 'MG_JOB_PROGRESS', ...ids, state: 'merging', pct: 100 });
      try {
        blob = remux(v.bytes, a?.bytes || null);
      } catch (e) {
        console.error('[MediaGrab] merge failed', e);
        warning = `audio merge failed (${e.message}), saved without sound`;
        blob = new Blob([v.bytes], { type: 'video/mp4' });
      }
      ext = 'mp4';
    } else {
      const r = await getBytes(plan.single, progress(0), false, sig);
      ext = EXT[r.type] || ext;
      blob = new Blob([r.bytes], { type: r.type || 'application/octet-stream' });
    }
    if (sig.aborted) throw new Error('cancelled');
    send({ type: 'MG_JOB_DONE', ...ids, url: URL.createObjectURL(blob), ext, warning });
  } catch (e) {
    if (!sig.aborted) console.error('[MediaGrab]', e);
    send({ type: 'MG_JOB_ERROR', ...ids, error: sig.aborted ? 'cancelled' : String(e?.message || e) });
  } finally {
    controllers.delete(jobId);
  }
}

function makeProgress(ids, parts) {
  const frac = new Array(parts).fill(0);
  let last = 0;
  return (i) => (got, total) => {
    frac[i] = total ? got / total : 0;
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    const pct = Math.min(99, Math.round((frac.reduce((a, b) => a + b, 0) / parts) * 100));
    send({ type: 'MG_JOB_PROGRESS', ...ids, state: 'downloading', pct });
  };
}

async function okFetch(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const getBytes = (src, onProgress, optional = false, signal) =>
  src.hls ? fetchHls(src.hls, onProgress, optional, signal) : fetchBytes(src.urls, onProgress, optional, signal);

// Try each URL in turn; returns the first one that delivers real media.
async function fetchBytes(urls, onProgress, optional = false, signal) {
  let lastErr;
  for (const url of [].concat(urls).filter(Boolean)) {
    try {
      const res = await okFetch(url, signal);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type.startsWith('text/html')) throw new Error('got a web page instead of media');
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress?.(got, total);
      }
      return { bytes: concat(chunks, got), type, url };
    } catch (e) {
      if (signal?.aborted) throw e; // cancelled: don't try the fallback URLs
      lastErr = e;
    }
  }
  if (optional) return null;
  throw lastErr || new Error('nothing to download');
}

// fMP4 HLS: init segment + media segments concatenated = one fragmented MP4.
async function fetchHls(url, onProgress, optional = false, signal) {
  try {
    const pl = parseMedia(await (await okFetch(url, signal)).text(), url);
    if (pl.ts || pl.byterange || !pl.segments.length) throw new Error('unsupported HLS format');
    const urls = [pl.init, ...pl.segments];
    const parts = new Array(urls.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < urls.length) {
        const i = next++;
        parts[i] = new Uint8Array(await (await okFetch(urls[i], signal)).arrayBuffer());
        onProgress?.(++done, urls.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
    return { bytes: concat(parts, parts.reduce((a, p) => a + p.length, 0)), type: 'video/mp4', url };
  } catch (e) {
    if (optional && !signal?.aborted) return null;
    throw e;
  }
}

function concat(chunks, size) {
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- sizes before download

// Size of the first URL that answers: a HEAD request, or a 1-byte range request whose
// Content-Range carries the total. Nothing is downloaded.
async function sizeOf(urls) {
  for (const url of [].concat(urls).filter(Boolean)) {
    try {
      let r = await fetch(url, { method: 'HEAD', credentials: 'include' });
      let n = r.ok ? Number(r.headers.get('content-length')) || 0 : 0;
      if (!n || /text\/html/i.test(r.headers.get('content-type') || '')) {
        const ctl = new AbortController();
        r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctl.signal });
        n = Number((r.headers.get('content-range') || '').split('/')[1]) || (r.status === 200 ? Number(r.headers.get('content-length')) || 0 : 0);
        ctl.abort();
      }
      if (n > 0 && !/text\/html/i.test(r.headers.get('content-type') || '')) return n;
    } catch {}
  }
  return 0;
}

// Exact size of what a download of this item would fetch: { bytes, vbytes? } or null.
async function itemSize(item, prefs) {
  const plan = await resolve(item.source, prefs);
  if (plan.video) {
    if (plan.video.hls) return null; // segmented stream: no single size to ask for
    const v = await sizeOf(plan.video.urls);
    if (!v) return null;
    const a = plan.audio ? await sizeOf(plan.audio.urls) : 0;
    return { bytes: v + a, vbytes: v };
  }
  const n = await sizeOf(plan.single.urls);
  return n ? { bytes: n } : null;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
  return r.json();
}

// ---------------------------------------------------------------- source resolvers
// Plan: { single: Src, ext } for one file, or { video: Src, audio?: Src } for a merge.
// Src: { urls: [...] } (first working URL wins) or { hls: playlistUrl }.

const single = (urls, ext = 'mp4') => ({ single: { urls: [].concat(urls).filter(Boolean) }, ext });

async function resolve(s, prefs) {
  switch (s.type) {
    case 'url': return single(s.urls, s.ext);
    case 'reddit': return resolveReddit(s, prefs);
    case 'ig': return resolveIg(s, prefs);
    case 'fb': return resolveFb(s, prefs);
    case 'x': return resolveX(s, prefs);
    case 'tiktok': return resolveTiktok(s, prefs);
    case 'redgifs': return single((await resolveRedgifs(s.id)));
    case 'streamable': return single(await resolveStreamable(s.id));
    case 'imgur': { const r = await resolveImgur(s.url); return single(r.urls, r.ext); }
    default: throw new Error(`unknown source type ${s.type}`);
  }
}

async function resolveReddit(s, prefs) {
  if (s.dash) {
    try {
      const { video, audio } = parseDash(await (await okFetch(s.dash)).text(), s.dash, prefs);
      if (video) return audio ? { video: { urls: [video.url, s.fallback] }, audio: { urls: [audio.url] } } : single([video.url, s.fallback]);
    } catch (e) {
      console.warn('[MediaGrab] Reddit DASH manifest failed, using fallback', e);
    }
  }
  // Manifest unavailable: use the fallback URL, or guess file names under v.redd.it/<id>/.
  const vid = s.vid || (String(s.dash || '').match(/v\.redd\.it\/([a-z0-9]+)/i) || [])[1];
  const dir = s.fallback ? s.fallback.replace(/[^/]*$/, '') : vid ? `https://v.redd.it/${vid}/` : null;
  if (!dir) throw new Error('no playable Reddit video URL');
  const heights = ['1080', '720', '480', '360', '240'].filter((h) => !prefs.maxHeight || +h <= prefs.maxHeight);
  const video = s.fallback && !prefs.maxHeight
    ? [s.fallback]
    : heights.flatMap((h) => [`CMAF_${h}.mp4`, `DASH_${h}.mp4`]).map((n) => dir + n).concat(s.fallback || []);
  if (!s.hasAudio) return single(video);
  const names = ['CMAF_AUDIO_128.mp4', 'CMAF_AUDIO_64.mp4', 'DASH_AUDIO_128.mp4', 'DASH_AUDIO_64.mp4', 'DASH_audio.mp4', 'audio'];
  return { video: { urls: video }, audio: { urls: names.map((n) => dir + n) } };
}

function resolveIg(s, prefs) {
  const prog = pickVideo(s.versions || [], prefs);
  const progUrls = [prog?.url, ...(s.versions || []).map((v) => v.url)];
  if (s.xml) {
    try {
      const { video, audio } = parseDash(s.xml, null, prefs);
      // Use DASH only when it's at least as sharp as the progressive file and keeps the sound.
      if (video && res(video) >= res(prog) && (audio || !s.hasAudio)) {
        return audio ? { video: { urls: [video.url, ...progUrls] }, audio: { urls: [audio.url] } } : single([video.url, ...progUrls]);
      }
    } catch (e) {
      console.warn('[MediaGrab] Instagram DASH parse failed', e);
    }
  }
  return single(progUrls);
}

function resolveFb(s, prefs) {
  let video = null, audio = null;
  if (s.reps?.length) ({ video, audio } = chooseReps(s.reps, prefs));
  if (!video && s.xml) {
    try { ({ video, audio } = parseDash(s.xml, null, prefs)); } catch (e) { console.warn('[MediaGrab] Facebook DASH parse failed', e); }
  }
  const prog = s.progressive || [];
  if (video && audio) return { video: { urls: [video.url, ...prog] }, audio: { urls: [audio.url] } };
  if (prog.length) return single(prog); // progressive files carry sound
  if (video) return single([video.url]);
  throw new Error('no playable Facebook video URL');
}

async function resolveX(s, prefs) {
  const mp4s = (s.variants || []).map((v) => ({ ...v, codec: 'avc1' }));
  const best = pickVideo(mp4s, prefs);
  const mp4Urls = [best?.url, ...[...mp4s].sort((a, b) => b.br - a.br).map((v) => v.url)];
  if (s.hls && prefs.xHls !== false && !s.gif) {
    try {
      const master = parseMaster(await (await okFetch(s.hls)).text(), s.hls);
      const v = pickVideo(master.variants, prefs);
      if (v && res(v) > res(best)) {
        const media = parseMedia(await (await okFetch(v.url)).text(), v.url);
        if (!media.ts && !media.byterange) {
          const group = v.audioGroup && master.audio[v.audioGroup];
          const a = group?.length ? pickAudio(group) : null;
          return { video: { hls: v.url }, audio: a ? { hls: a.url } : null };
        }
      }
    } catch (e) {
      console.warn('[MediaGrab] X HLS failed, using MP4', e);
    }
  }
  if (!best) throw new Error('no MP4 version of this video');
  return single(mp4Urls);
}

function resolveTiktok(s, prefs) {
  const cands = s.cands || [];
  const best = pickVideo(cands, prefs);
  if (!best) throw new Error('no playable TikTok URL');
  return single([...new Set([...best.urls, ...cands.flatMap((c) => c.urls)])]);
}

let rgToken = null;
async function resolveRedgifs(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    rgToken ||= (await getJson('https://api.redgifs.com/v2/auth/temporary')).token;
    const r = await fetch(`https://api.redgifs.com/v2/gifs/${id}`, { headers: { Authorization: `Bearer ${rgToken}` } });
    if (r.status === 401 || r.status === 403) { rgToken = null; continue; }
    if (!r.ok) throw new Error(`Redgifs HTTP ${r.status}`);
    const u = (await r.json()).gif?.urls || {};
    return [u.hd, u.sd].filter(Boolean);
  }
  throw new Error('Redgifs authorization failed');
}

async function resolveStreamable(id) {
  const j = await getJson(`https://api.streamable.com/videos/${id}`);
  const files = Object.values(j.files || {})
    .filter((f) => f?.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (!files.length) throw new Error('Streamable video not ready or removed');
  return files.map((f) => (f.url.startsWith('//') ? 'https:' + f.url : f.url));
}

async function resolveImgur(url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/([A-Za-z0-9]{5,10})(?:\.(\w+))?$/);
  if (m?.[2]) {
    const ext = m[2].toLowerCase();
    if (['gifv', 'gif', 'mp4', 'webm'].includes(ext)) {
      return { urls: [`https://i.imgur.com/${m[1]}.mp4`, `https://i.imgur.com/${m[1]}.${ext === 'gifv' ? 'gif' : ext}`], ext: 'mp4' };
    }
    return { urls: [`https://i.imgur.com/${m[1]}.${ext}`], ext };
  }
  if (m) {
    const html = await (await fetch(`https://imgur.com/${m[1]}`)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (p) => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content;
    const v = meta('og:video') || meta('twitter:player:stream');
    if (v) return { urls: [v], ext: 'mp4' };
    const img = meta('og:image');
    if (img) return { urls: [img.replace(/\?.*$/, '')], ext: 'jpg' };
  }
  throw new Error('unsupported Imgur link (albums are not handled)');
}
