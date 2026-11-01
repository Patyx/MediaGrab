import { getSettings } from '../lib/settings.js';
import { overLimit, fmtSize, fmtRate } from '../lib/compress.js';
import { helperOutdated } from '../lib/helper.js';

const listEl = document.getElementById('list');
const allBtn = document.getElementById('all');
const noticeEl = document.getElementById('notice');
const rows = new Map(); // item key -> { status element, kind, sig }
let items = [];

// Per-video "Compress to HEVC" toggles: key -> { on, touched }. An untouched toggle that was
// pre-ticked by the auto setting sends 'auto' (helper re-checks the real bitrate); one the
// user ticked sends 'force'.
const compressState = new Map();
const compressMode = (key) => {
  const c = compressState.get(key);
  return c?.on ? (c.touched ? 'force' : 'auto') : null;
};

// Settings and helper status, needed for the compress toggles (loaded in parallel).
const prefsP = getSettings();
const helperP = chrome.runtime.sendMessage({ to: 'sw', type: 'MG_HELPER_STATUS' }).then((r) => (r?.ok ? r.data : null), () => null);

const SITE_NAMES = { reddit: 'Reddit', x: 'X', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const sw = (msg) => chrome.runtime.sendMessage({ to: 'sw', ...msg });

function showMessage(text) {
  listEl.replaceChildren(el('p', 'muted', text));
}

function render(posts) {
  listEl.replaceChildren();
  items = posts.flatMap((p) => p.items || []);
  if (!posts.length) {
    showMessage("No media found in view. Open a post or scroll one into view and try again. If the page was open before MediaGrab was updated, reload it once.");
    return;
  }
  for (const p of posts) {
    const box = el('section', 'post');
    const head = el('div', 'post-h');
    head.append(el('span', 'site', SITE_NAMES[p.items?.[0]?.site] || ''), el('span', 'author', p.author || p.postId));
    box.append(head);
    if (p.title) box.append(el('div', 'title', p.title));
    if (p.error && !p.items?.length) box.append(el('div', 'err-line', p.error));
    for (const it of p.items || []) box.append(renderItem(it));
    listEl.append(box);
  }
  allBtn.hidden = items.length < 2;
  allBtn.textContent = `Download all (${items.length})`;
  decorate();
}

// "≈ 48 MB · 7.8 Mbps" line (estimate before downloading), when the site tells us.
function estLine(est) {
  const line = el('div', 'est');
  setEst(line, est);
  return line;
}
function setEst(line, est) {
  const parts = [];
  if (est?.bytes) parts.push(`≈ ${fmtSize(est.bytes)}`);
  if (est?.vkbps) parts.push(fmtRate(est.vkbps));
  line.textContent = parts.join(' · ');
}

function renderItem(it) {
  const row = el('div', 'row');
  let thumb;
  if (it.thumb) {
    thumb = el('img', 'thumb');
    thumb.src = it.thumb;
    thumb.alt = '';
    thumb.referrerPolicy = 'no-referrer';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    thumb.onerror = () => thumb.replaceWith(el('div', 'thumb', it.kind === 'video' ? '▶' : '▣'));
  } else {
    thumb = el('div', 'thumb', it.kind === 'video' ? '▶' : '▣');
  }
  const meta = el('div', 'meta');
  const n = it.count > 1 ? ` ${it.index + 1}/${it.count}` : '';
  meta.append(el('div', 'name', `${it.kind === 'video' ? 'Video' : 'Image'}${n}${it.label ? ' · ' + it.label : ''}`));
  const est = estLine(it.est);
  const status = el('div', 'status', '');
  meta.append(est, status);
  const btns = saveButtons(() => download([it]), it.kind === 'video' ? () => download([it], 'audio') : null, it.kind);
  rows.set(it.key, { status, kind: it.kind, est, chipSlot: btns.chipSlot, item: it });
  row.append(thumb, meta, btns);
  return row;
}

// Compress toggle chip. Shown only when the helper (which does the encoding) is available.
function makeChip(key, initialOn) {
  compressState.set(key, { on: initialOn, touched: false });
  const chip = el('button', 'chip');
  const paint = () => {
    const on = compressState.get(key).on;
    chip.textContent = on ? 'Compress ✓' : 'Compress';
    chip.setAttribute('aria-pressed', String(on));
  };
  chip.title = 'Re-encode to HEVC after saving (keeps the original if it saves too little)';
  chip.onclick = () => {
    const c = compressState.get(key);
    c.on = !c.on;
    c.touched = true;
    paint();
  };
  chip.repaint = paint;
  paint();
  return chip;
}

// Once settings + helper status are known: flag over-limit videos and add the toggles.
async function decorate() {
  const [prefs, helper] = await Promise.all([prefsP, helperP]);
  const canCompress = !!(helper?.installed && prefs.useHelper);
  const outdated = canCompress && helperOutdated(helper.version);
  for (const [key, r] of rows) {
    if (r.kind !== 'video' || !r.item) continue;
    const over = overLimit(r.item.est, prefs);
    if (over) {
      r.est.classList.add('over');
      r.est.title = 'Over your bitrate limit: worth compressing';
    }
    if (canCompress && !r.chipSlot.firstChild) {
      // Pre-tick when over the limit; unknown bitrate + auto still lets the helper decide.
      r.chipSlot.append(outdated ? outdatedChip(helper.version) : makeChip(key, prefs.autoCompress && over !== false));
    }
  }
}

// Compression needs helper 1.4+: show why it's unavailable instead of failing silently.
function outdatedChip(version) {
  const chip = el('button', 'chip', 'Compress');
  chip.disabled = true;
  chip.title = `The MediaGrab Helper on this PC (${version || 'old version'}) is too old to compress. Run helper\\install.bat again.`;
  return chip;
}

// Big square Save button, a slim full-height Audio button to its right (videos only),
// and a slot under both for the Compress toggle.
function saveButtons(onSave, onAudio, kind = 'video') {
  const btns = el('div', 'btns');
  const save = el('button', 'save');
  save.title = kind === 'video' ? 'Save video' : 'Save image';
  save.setAttribute('aria-label', save.title);
  save.append(el('span', 'ico', '⬇'), el('span', 'lbl', 'Save'));
  save.onclick = onSave;
  btns.append(save);
  if (onAudio) {
    const audio = el('button', 'audio');
    audio.title = 'Save audio only';
    audio.setAttribute('aria-label', audio.title);
    audio.append(el('span', 'ico', '♪'), el('span', 'lbl', 'Audio'));
    audio.onclick = onAudio;
    btns.append(audio);
  }
  btns.chipSlot = el('div', 'chip-slot');
  btns.append(btns.chipSlot);
  return btns;
}

function download(list, mode = 'media') {
  const compress = {};
  for (const it of list) {
    setStatus(it.key, { state: 'queued', mode });
    if (mode === 'media' && compressMode(it.key)) compress[it.key] = compressMode(it.key);
  }
  sw({ type: 'MG_DOWNLOAD', items: list, mode, compress });
}

const TEXT = {
  queued: () => 'Queued…',
  downloading: (j) => `Downloading${j.pct ? ` ${j.pct}%` : '…'}`,
  merging: (j) => (j.mode === 'audio' ? 'Extracting…' : 'Merging video + audio…'),
  saving: () => 'Saving…',
  compressing: (j) => `Compressing to HEVC${j.pct ? ` ${j.pct}%` : '…'}`,
  done: (j) => (j.warning ? `Saved, but ${j.warning}` : 'Saved ✓'),
  error: (j) => `Failed: ${j.error}`,
  cancelled: () => 'Cancelled',
};

// Open (▶ / ↗) or show-in-folder (📁) a saved file: Chrome downloads directly from the
// popup (needs the click), helper saves through the helper.
async function openSaved(j, show) {
  try {
    if (j.downloadId != null) {
      if (show) chrome.downloads.show(j.downloadId);
      else await chrome.downloads.open(j.downloadId);
      return;
    }
    const r = await sw({ type: 'MG_OPEN_SAVED', path: j.path, show });
    if (!r?.ok) throw new Error(r?.error);
  } catch (e) {
    noticeEl.hidden = false;
    noticeEl.textContent = `Couldn't open the file: ${e?.message || 'unknown error'}`;
  }
}

function fileButtons(j, kind) {
  const wrap = el('span', 'file-acts');
  const folder = el('button', 'mini', '📁');
  folder.title = 'Show in folder';
  folder.setAttribute('aria-label', folder.title);
  folder.onclick = () => openSaved(j, true);
  const open = el('button', 'mini', kind === 'image' ? '↗' : '▶');
  open.title = kind === 'image' ? 'Open image' : j.mode === 'audio' ? 'Play audio' : 'Play video';
  open.setAttribute('aria-label', open.title);
  open.onclick = () => openSaved(j, false);
  wrap.append(folder, open);
  return wrap;
}

function setStatus(key, j) {
  const r = rows.get(key);
  if (!r) return;
  const sig = JSON.stringify(j);
  if (r.sig === sig) return; // unchanged: skip the DOM work
  r.sig = sig;
  const s = r.status;
  const done = j.state === 'done';
  let text = (j.via === 'yt-dlp' ? 'yt-dlp · ' : '') + (j.mode === 'audio' ? 'Audio: ' : '') + (TEXT[j.state] || (() => j.state))(j);
  if (done && j.size) text += ` · ${fmtSize(j.size)}`;
  if (done && j.note) text += ` · ${j.note}`;
  s.replaceChildren(el('span', '', text));
  if (done && (j.path || j.downloadId != null)) s.append(fileButtons(j, r.kind));
  s.className = 'status' + (j.state === 'error' ? ' err' : done ? (j.warning ? ' warn' : ' ok') : '');
}

function applyStatus(data) {
  for (const j of data?.jobs || []) setStatus(j.key, j); // later jobs for the same key win
  noticeEl.hidden = !data?.lastError;
  noticeEl.textContent = data?.lastError || '';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.to === 'popup' && msg.type === 'MG_STATUS') applyStatus(msg.data);
});

allBtn.onclick = () => download(items);
document.getElementById('settings').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('folder').onclick = () => sw({ type: 'MG_OPEN_FOLDER' }).catch(() => {});

// ---------------------------------------------------------------- yt-dlp panel

const domainOf = (url) => new URL(url).hostname.split('.').slice(-2).join('.');

function ytdlp(url, audio, key, height = null) {
  // Cookie access for this site (asked once per site; must run inside the click).
  const compress = audio ? null : compressMode(key);
  chrome.permissions.request({ origins: [`*://*.${domainOf(url)}/*`] })
    .catch(() => false)
    .finally(() => {
      setStatus(key, { state: 'queued', via: 'yt-dlp', mode: audio ? 'audio' : 'media' });
      sw({ type: 'MG_YTDLP', url, audio, key, height, compress });
    });
}

const STANDARD = [2160, 1440, 1080, 720, 480, 360];
const qLabel = (h) => `${h}p${h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : ''}`;

// Fill the quality dropdown: preselect the remembered quality, or the highest one below it.
// Also shows the size/bitrate estimate for the selected quality and pre-ticks compression.
async function fillQualities(sel, hint, est, chip, key, url) {
  const [store, r, prefs] = await Promise.all([
    chrome.storage.local.get('ytQuality').catch(() => ({})),
    sw({ type: 'MG_YTDLP_PROBE', url }).catch((e) => ({ ok: false, error: e.message })),
    prefsP,
  ]);
  const preferred = Number(store.ytQuality) || 0; // 0 = best available
  const found = r?.ok ? r.data.qualities : [];
  const estimates = (r?.ok && r.data.estimates) || {};
  const list = found.length ? found : STANDARD;
  sel.replaceChildren(...list.map((h) => new Option(qLabel(h), String(h))));
  let pick = list[0];
  if (preferred) {
    pick = list.find((h) => h <= preferred) ?? list[list.length - 1];
    if (found.length && pick !== preferred) hint.textContent = `${qLabel(preferred)} isn't available, picked ${qLabel(pick)}`;
  }
  sel.value = String(pick);
  sel.disabled = false;
  if (!found.length) hint.textContent = r?.ok ? 'No video qualities listed; yt-dlp will pick the closest.' : `Couldn't list qualities: ${r?.error || 'unknown error'}`;
  const showEst = () => {
    const e = estimates[sel.value];
    setEst(est, e);
    const over = overLimit(e, prefs);
    est.classList.toggle('over', !!over);
    const c = compressState.get(key);
    if (c && !c.touched) { c.on = !!(prefs.autoCompress && over !== false); chip?.repaint(); }
  };
  showEst();
  sel.onchange = () => {
    hint.textContent = '';
    chrome.storage.local.set({ ytQuality: Number(sel.value) }).catch(() => {});
    showEst();
  };
}

async function renderYtdlp(tab, helper) {
  const box = el('section', 'post');
  const head = el('div', 'post-h');
  head.append(el('span', 'site', 'yt-dlp'), el('span', 'author', new URL(tab.url).hostname.replace(/^www\./, '')));
  box.append(head);
  if (tab.title) box.append(el('div', 'title', tab.title));
  if (!helper?.installed) {
    const p = el('div', 'status', 'Install the MediaGrab Helper to download from this page with yt-dlp. ');
    const a = el('a', '', 'How?');
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    p.append(a);
    box.append(p);
    listEl.append(box);
    return;
  }
  const key = `ytdlp:${tab.url}`;
  const row = el('div', 'row');
  const meta = el('div', 'meta');
  meta.append(el('div', 'name', 'Video on this page'));
  const sel = el('select', 'quality');
  sel.title = 'Video quality';
  sel.disabled = true;
  sel.append(new Option('Finding qualities…', ''));
  const hint = el('div', 'hint', '');
  const est = el('div', 'est', '');
  const status = el('div', 'status', '');
  meta.append(sel, hint, est, status);
  rows.set(key, { status, kind: 'video' });
  const btns = saveButtons(
    () => ytdlp(tab.url, false, key, sel.value ? Number(sel.value) : null),
    () => ytdlp(tab.url, true, key),
  );
  const prefs = await prefsP;
  let chip = null;
  if (prefs.useHelper) {
    chip = helperOutdated(helper.version) ? null : makeChip(key, false);
    btns.chipSlot.append(chip || outdatedChip(helper.version));
  }
  fillQualities(sel, hint, est, chip, key, tab.url);
  row.append(el('div', 'thumb', '▶'), meta, btns);
  box.append(row);
  listEl.append(box);
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusP = sw({ type: 'MG_STATUS_GET' }).catch(() => null);
  const res = await sw({ type: 'MG_LIST_TAB', tabId: tab.id }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) {
    showMessage(res?.error || 'Something went wrong.');
  } else if (!res.data.unsupported) {
    render(res.data.posts); // native sites never fall back to yt-dlp
  } else if (/^https?:/.test(tab.url || '')) {
    listEl.replaceChildren();
    await renderYtdlp(tab, await helperP);
  } else {
    showMessage('Open a page with a video to download it.');
  }
  const st = await statusP;
  if (st?.ok) applyStatus(st.data);
})();
