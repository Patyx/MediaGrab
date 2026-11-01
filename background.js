// Service worker: context menu, job queue, chrome.downloads, and the bridge between
// popup, content scripts, the offscreen document and the optional Windows helper.
import { getSettings as loadSettings, buildName, cleanFolder } from './lib/settings.js';
import { helperStatus, helperSave, ytdlpDownload, ytdlpUpdate, ytdlpProbe, cookiesFor, helperOpenFolder, helperOpenFile, helperCompress, helperEncoders } from './lib/helper.js';
import { fmtSize, fmtRate, encoderName } from './lib/compress.js';

// Settings are read on every job; cache them until they change.
let settingsCache = null;
const getSettings = () => (settingsCache ||= loadSettings());
chrome.storage.onChanged.addListener((_c, area) => { if (area === 'sync') settingsCache = null; });

// Popup probes for yt-dlp pages: url -> { promise, at }. The info file is reused by the
// next download of that page, and an in-flight probe is awaited rather than repeated.
const probes = new Map();
const PROBE_TTL = 10 * 60e3;

// Remember the last file the helper saved, for the popup's "Open folder" button.
const rememberSaved = (path) => { if (path) chrome.storage.local.set({ lastSavedPath: path }).catch(() => {}); };

const SITES = [
  { id: 'reddit', re: /(^|\.)reddit\.com$/, hook: false },
  { id: 'x', re: /(^|\.)(x|twitter)\.com$/, hook: true },
  { id: 'instagram', re: /(^|\.)instagram\.com$/, hook: true },
  { id: 'tiktok', re: /(^|\.)tiktok\.com$/, hook: true },
  { id: 'facebook', re: /(^|\.)facebook\.com$/, hook: true },
];
const MENU_PATTERNS = ['*://*.reddit.com/*', '*://*.x.com/*', '*://*.twitter.com/*', '*://*.instagram.com/*', '*://*.tiktok.com/*', '*://*.facebook.com/*'];
const TIKTOK_DOMAINS = ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us', 'tiktokv.eu', 'byteoversea.com', 'ibyteimg.com', 'muscdn.com'];

const siteOf = (url) => {
  try {
    const h = new URL(url).hostname;
    return SITES.find((s) => s.re.test(h)) || null;
  } catch {
    return null;
  }
};

// TikTok's CDN refuses requests without a tiktok.com Referer. Only applies to requests
// made by this extension (tabId -1), never to pages you browse.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.tiktok.com/' }] },
    condition: { requestDomains: TIKTOK_DOMAINS, tabIds: [-1], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
  }],
}).catch((e) => console.warn('[MediaGrab] DNR rule failed', e));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const common = { contexts: ['page', 'link', 'image', 'video'], documentUrlPatterns: MENU_PATTERNS };
    chrome.contextMenus.create({ id: 'mg-post', title: 'Download media from this post', ...common });
    chrome.contextMenus.create({ id: 'mg-audio', title: 'Download audio from this post', ...common });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!['mg-post', 'mg-audio'].includes(info.menuItemId) || !tab?.id) return;
  const audio = info.menuItemId === 'mg-audio';
  try {
    const posts = (await askContent(tab, { type: 'MG_CONTEXT', linkUrl: info.linkUrl, srcUrl: info.srcUrl })) || [];
    let items = posts.flatMap((p) => p.items || []);
    if (audio) items = items.filter((it) => it.kind === 'video');
    if (!items.length) throw new Error(posts.find((p) => p.error)?.error || (audio ? 'No video with audio in this post' : 'No media found in this post'));
    const group = items.length > 1 ? crypto.randomUUID() : null;
    const prefs = await getSettings();
    const compress = !audio && prefs.autoCompress ? 'auto' : null;
    items.forEach((it) => startJob(it, audio ? 'audio' : 'media', group, it.kind === 'video' ? compress : null));
  } catch (e) {
    flagError(e);
  }
});

// ---------------------------------------------------------------- content scripts

// Returns the content script's posts, or null when the site isn't one MediaGrab handles.
async function askContent(tab, msg) {
  const site = siteOf(tab.url);
  if (!site) return null;
  const ask = () => chrome.tabs.sendMessage(tab.id, { to: 'content', ...msg }, { frameId: 0 });
  let res;
  try {
    res = await ask();
  } catch {
    // No live content script: the tab predates an install/update/reload. A stale copy can
    // still sit in the page, so clear it first or the fresh one would step aside.
    const target = { tabId: tab.id };
    if (site.hook) await chrome.scripting.executeScript({ target, files: ['inject/hook.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target, func: () => { delete globalThis.MG; } }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['content/common.js', `content/${site.id}.js`] });
    res = await ask();
  }
  if (!res) throw new Error('No response from the page. Try reloading it.');
  if (!res.ok) throw new Error(res.error);
  return res.posts;
}

// ---------------------------------------------------------------- saving

const isCancel = (e) => /cancel/i.test(String(e?.message || e));
const FINISHED = new Set(['done', 'error', 'cancelled']);

function downloadOpts(url, name, ext, s) {
  if (s.saveAs) return { url, filename: `${name}.${ext}`, saveAs: true, conflictAction: 'uniquify' };
  const folder = cleanFolder(s.folder);
  return { url, filename: `${folder ? folder + '/' : ''}${name}.${ext}`, saveAs: false, conflictAction: 'uniquify' };
}

// If Chrome rejects the name (unusual Unicode etc.), retry once with a plain ASCII version.
async function saveFile(url, name, ext) {
  const s = await getSettings();
  try {
    return await chrome.downloads.download(downloadOpts(url, name, ext, s));
  } catch (e) {
    if (!/filename/i.test(String(e?.message || e))) throw e;
    const ascii = name.normalize('NFKD').replace(/[^\w .()-]+/g, '').replace(/\s+/g, ' ').trim() || 'download';
    return chrome.downloads.download(downloadOpts(url, ascii, ext, { ...s, folder: cleanFolder(s.folder).replace(/[^\w ./-]+/g, '') }));
  }
}

// ---------------------------------------------------------------- jobs

const jobs = new Map();
let lastError = null;

// Finished jobs survive service-worker restarts (session storage), so a reopened popup
// still shows "Saved · size" with its open buttons.
const PUBLIC = ['jobId', 'key', 'state', 'pct', 'error', 'warning', 'note', 'mode', 'via', 'path', 'size', 'downloadId', 'at'];
const pick = (j) => Object.fromEntries(PUBLIC.map((k) => [k, j[k]]));
const restored = chrome.storage.session.get('jobs').then(({ jobs: saved }) => {
  for (const j of saved || []) if (!jobs.has(j.jobId)) jobs.set(j.jobId, j);
}).catch(() => {});

const snapshot = () => ({
  jobs: [...jobs.values()].map(pick),
  lastError: lastError && Date.now() - lastError.at < 5 * 60e3 ? lastError.message : null,
});

// Coalesce status pushes (progress events can arrive many times a second).
let pushTimer = null;
function pushStatus() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const all = [...jobs.values()];
    const active = all.filter((j) => !FINISHED.has(j.state)).length;
    const snap = snapshot();
    const failed = all.some((j) => j.state === 'error') || !!snap.lastError;
    chrome.action.setBadgeBackgroundColor({ color: active ? '#2563eb' : '#dc2626' });
    chrome.action.setBadgeText({ text: active ? String(active) : failed ? '!' : '' });
    chrome.runtime.sendMessage({ to: 'popup', type: 'MG_STATUS', data: snap }).catch(() => {});
    chrome.storage.session.set({ jobs: all.filter((j) => FINISHED.has(j.state)).map(pick) }).catch(() => {});
  }, 100);
}

function flagError(e) {
  lastError = { message: String(e?.message || e), at: Date.now() };
  console.warn('[MediaGrab]', lastError.message);
  pushStatus();
}

function upsert(m) {
  let j = jobs.get(m.jobId);
  if (!j) {
    j = { jobId: m.jobId, key: m.key, name: m.name, mode: m.mode, state: 'queued', pct: 0, at: Date.now() };
    jobs.set(m.jobId, j);
  }
  return j;
}

function fail(j, e) {
  j.at = Date.now();
  if (isCancel(e)) {
    j.state = 'cancelled';
    return;
  }
  j.state = 'error';
  j.error = String(e?.message || e);
}

function finish(j, { path, size }) {
  j.path = path;
  j.size = size ?? null;
  j.state = 'done';
  j.pct = 100;
  j.at = Date.now();
  rememberSaved(path);
}

function prune() {
  const cutoff = Date.now() - 30 * 60e3;
  for (const [id, j] of jobs) if (FINISHED.has(j.state) && j.at < cutoff) jobs.delete(id);
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creatingOffscreen ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Fetch media, merge separate audio/video streams, and pass the file to chrome.downloads.',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

const helperReady = async (prefs) => prefs.useHelper && (await helperStatus()).installed;

// Hand a finished file (blob: or https:) to the helper's Save dialog, or to Chrome's downloads.
// Audio jobs arrive as M4A; with the MP3 setting the helper converts them with ffmpeg.
async function deliver(j, url, ext) {
  const prefs = await getSettings();
  const wantMp3 = j.mode === 'audio' && prefs.audioFormat === 'mp3';
  j.state = 'saving';
  pushStatus();
  if (await helperReady(prefs)) {
    try {
      const compress = j.compress && j.mode !== 'audio' && ext === 'mp4';
      const saved = await helperSave({
        url, name: j.name, ext: wantMp3 ? 'mp3' : ext, group: j.group,
        convert: wantMp3 ? 'mp3' : null, stage: compress, mp3Quality: prefs.mp3Quality,
      });
      revoke(j);
      finish(j, saved.staged ? await runCompress(j, saved.staged, saved.path) : saved);
      pushStatus();
      return;
    } catch (e) {
      if (isCancel(e)) {
        fail(j, e);
        revoke(j);
        pushStatus();
        return;
      }
      console.warn('[MediaGrab] helper save failed, using Chrome downloads', e);
      j.warning = `helper failed (${e.message}), saved via Chrome${wantMp3 ? ' as M4A' : ''}`;
    }
  } else if (wantMp3) {
    j.warning = 'MP3 needs the MediaGrab Helper (with "Save files through the helper" on), saved as M4A';
  }
  j.downloadId = await saveFile(url, j.name, ext);
}

// Re-encode a saved video to HEVC via the helper; returns { path, size } of the kept file.
async function runCompress(j, input, output) {
  const prefs = await getSettings();
  j.state = 'compressing';
  j.pct = 0;
  pushStatus();
  let r;
  try {
    r = await helperCompress({
      input, output, mode: j.compress === 'force' ? 'force' : 'auto',
      limit720: prefs.limit720, limit1080: prefs.limit1080, encoder: prefs.encoder,
      quality: prefs.quality, x265Preset: prefs.x265Preset, minSavings: prefs.minSavings,
    }, (pct) => { j.pct = pct; pushStatus(); });
  } catch (e) {
    j.warning = `compression failed (${e.message}); the original may still be named "${input}"`;
    return { path: input, size: null };
  }
  if (r.outcome === 'compressed') j.note = `HEVC −${r.savedPct}% (was ${fmtSize(r.origSize)}) · ${encoderName(r.encoder)}`;
  else if (r.outcome === 'kept') j.note = `kept original: HEVC only saved ${r.savedPct}%`;
  else if (r.outcome === 'under-limit') j.note = `kept original: ${fmtRate(r.vkbps)} is under the ${fmtRate(r.limit)} limit`;
  else if (r.outcome === 'failed') j.warning = `compression failed (${r.error}), saved the original`;
  return { path: r.path, size: r.size };
}

const siteLabel = (url) => {
  try { return new URL(url).hostname.replace(/^(www|m)\./, '').split('.').slice(-2, -1)[0] || 'web'; } catch { return 'web'; }
};

// yt-dlp, only for sites MediaGrab doesn't handle itself.
// height: quality picked in the popup (resolution then wins over "prefer H.264").
// info: a probe result whose info file the download can reuse.
async function runYtdlp(j, { url, audio, height = null, info = null }) {
  const prefs = await getSettings();
  const makeName = (i) => buildName({
    site: siteLabel(url),
    handle: String(i.uploader_id || '').replace(/^@/, '') || i.uploader,
    handleKind: 'user',
    desc: i.title,
    postId: i.id,
  }, prefs);
  j.via = 'yt-dlp';
  j.state = 'downloading';
  j.pct = 0;
  j.error = undefined;
  pushStatus();
  try {
    let saved = await ytdlpDownload({
      url,
      name: info ? makeName(info) : null,
      infoFile: info?.infoFile || null,
      ext: audio || 'mp4',
      audio,
      mp3Quality: prefs.mp3Quality,
      maxHeight: height ?? prefs.maxHeight,
      resFirst: height != null,
      preferH264: prefs.preferH264,
      cookies: await cookiesFor(url),
      playlistItem: null,
      group: j.group,
      makeName,
      onProgress: (pct) => { j.pct = pct; pushStatus(); },
    });
    if (j.compress && !audio && /\.mp4$/i.test(saved.path || '')) saved = await runCompress(j, saved.path, saved.path);
    finish(j, saved);
  } catch (e) {
    fail(j, e);
  }
  pushStatus();
}

// compress: null | 'auto' (only if over the limit) | 'force' (always try).
async function startJob(item, mode = 'media', group = null, compress = null) {
  prune();
  const prefs = await getSettings();
  const name = item.name ? buildName(item.name, prefs) : item.filename.replace(/\//g, '_');
  const j = upsert({ jobId: crypto.randomUUID(), key: item.key, name, mode });
  j.group = group;
  j.compress = item.kind === 'video' && mode === 'media' ? compress : null;
  pushStatus();
  try {
    const s = item.source;
    if (s.type === 'url' && !s.fetch && mode !== 'audio') {
      // Plain file the browser (or helper) can fetch itself.
      await deliver(j, s.urls[0], s.ext);
    } else {
      await ensureOffscreen();
      j.state = 'downloading';
      await chrome.runtime.sendMessage({ to: 'offscreen', type: 'MG_JOB', jobId: j.jobId, item, prefs, mode, name });
    }
  } catch (e) {
    fail(j, e);
  }
  pushStatus();
}

function revoke(j) {
  if (!j.blobUrl) return;
  chrome.runtime.sendMessage({ to: 'offscreen', type: 'MG_REVOKE', url: j.blobUrl }).catch(() => {});
  j.blobUrl = null;
}

chrome.downloads.onChanged.addListener(async (d) => {
  const j = [...jobs.values()].find((x) => x.downloadId === d.id);
  if (!j || !d.state) return;
  if (d.state.current === 'complete') {
    const [it] = await chrome.downloads.search({ id: d.id }).catch(() => []);
    finish(j, { path: it?.filename, size: it?.fileSize || it?.totalBytes || null });
  } else if (d.state.current === 'interrupted') {
    fail(j, d.error?.current || 'download interrupted');
  } else {
    return;
  }
  revoke(j);
  pushStatus();
});

// ---------------------------------------------------------------- messages

const fresh = (p) => p && Date.now() - p.at < PROBE_TTL;

const handlers = {
  // { unsupported: true } on sites MediaGrab doesn't handle (popup then offers yt-dlp).
  async MG_LIST_TAB({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    const posts = await askContent(tab, { type: 'MG_LIST' });
    return posts === null ? { unsupported: true, posts: [] } : { unsupported: false, posts };
  },
  // compress: { [item key]: 'auto' | 'force' } from the popup's per-item toggles.
  MG_DOWNLOAD({ items, mode, compress }) {
    lastError = null;
    const group = items.length > 1 ? crypto.randomUUID() : null;
    items.forEach((it) => startJob(it, mode || 'media', group, compress?.[it.key] || null));
  },
  MG_HELPER_ENCODERS({ force }) {
    return helperEncoders(!!force);
  },
  async MG_STATUS_GET() {
    await restored;
    return snapshot();
  },
  // Last helper save's folder (file selected), else Chrome's Downloads folder.
  async MG_OPEN_FOLDER() {
    const prefs = await getSettings();
    if (prefs.useHelper && (await helperStatus()).installed) {
      const { lastSavedPath } = await chrome.storage.local.get('lastSavedPath');
      await helperOpenFolder(lastSavedPath);
      return 'helper';
    }
    chrome.downloads.showDefaultFolder();
    return 'chrome';
  },
  // Open / show a file the helper saved (Chrome downloads are opened by the popup itself).
  async MG_OPEN_SAVED({ path, show }) {
    if (!path) throw new Error('No file to open');
    return show ? helperOpenFolder(path) : helperOpenFile(path);
  },
  MG_HELPER_STATUS({ force, full }) {
    return helperStatus(!!force, !!full);
  },
  async MG_HELPER_UPDATE() {
    const r = await ytdlpUpdate();
    await helperStatus(true, true);
    return r;
  },
  async MG_YTDLP({ url, audio, key, height, compress }) {
    lastError = null;
    const prefs = await getSettings();
    const j = upsert({ jobId: crypto.randomUUID(), key, name: null, mode: audio ? 'audio' : 'media' });
    j.compress = audio ? null : compress || null;
    pushStatus();
    const p = probes.get(url);
    probes.delete(url); // the helper deletes the info file after use
    const info = fresh(p) ? await p.promise.then((r) => r.info, () => null) : null;
    runYtdlp(j, { url, audio: audio ? prefs.audioFormat : null, height: audio ? null : (height ?? null), info });
  },
  // Qualities on offer for the page (cached and reused by the next download).
  async MG_YTDLP_PROBE({ url }) {
    let p = probes.get(url);
    if (!fresh(p)) {
      p = { at: Date.now(), promise: (async () => ytdlpProbe(url, await cookiesFor(url)))() };
      probes.set(url, p);
      p.promise.catch(() => { if (probes.get(url) === p) probes.delete(url); });
    }
    const r = await p.promise;
    return { qualities: r.qualities, estimates: r.estimates };
  },
  async MG_FETCH_JSON({ url, headers }) {
    const r = await fetch(url, { credentials: 'include', headers: headers || {} });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  MG_JOB_PROGRESS(m) {
    const j = upsert(m);
    j.state = m.state;
    j.pct = m.pct;
    pushStatus();
  },
  async MG_JOB_DONE(m) {
    const j = upsert(m);
    j.warning = [j.warning, m.warning].filter(Boolean).join('; ');
    j.blobUrl = m.url;
    j.name ||= m.name || 'download';
    try {
      await deliver(j, m.url, m.ext);
    } catch (e) {
      fail(j, e);
      revoke(j);
    }
    pushStatus();
  },
  MG_JOB_ERROR(m) {
    fail(upsert(m), m.error);
    pushStatus();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'sw') return;
  const h = handlers[msg.type];
  if (!h) return;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
