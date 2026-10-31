import { DEFAULTS, getSettings, buildName } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULTS);
let savedTimer;

const sample = { site: 'reddit', handle: 'videos', handleKind: 'subreddit', desc: 'My cat does a backflip off the fridge and lands perfectly', postId: '1abc23', index: 1, count: 3 };

function read() {
  const s = {};
  for (const k of fields) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'number' || k === 'maxHeight') s[k] = Number(el.value) || 0;
    else s[k] = el.value;
  }
  return s;
}

function refresh(s) {
  $('preview').textContent = `${buildName(sample, s)}.mp4`;
  $('folderRow').setAttribute('aria-disabled', String(s.saveAs));
  $('folder').disabled = s.saveAs;
}

async function save() {
  const s = read();
  refresh(s);
  await chrome.storage.sync.set(s);
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').hidden = true; }, 1200);
}

(async () => {
  const s = await getSettings();
  for (const k of fields) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = String(s[k]);
    el.addEventListener(el.type === 'text' || el.type === 'number' ? 'input' : 'change', save);
  }
  refresh(s);
  checkHelper(true);
})();

// ---------------------------------------------------------------- helper status

const sw = (msg) => chrome.runtime.sendMessage({ to: 'sw', ...msg });

async function checkHelper(force) {
  const st = $('helperStatus');
  st.className = 'preview';
  st.textContent = 'Checking…';
  const r = await sw({ type: 'MG_HELPER_STATUS', force, full: true }).catch((e) => ({ ok: false, error: e.message }));
  const h = r?.ok ? r.data : { installed: false, error: r?.error };
  $('helperInstall').hidden = h.installed;
  $('helperUpdate').hidden = !h.installed;
  if (h.installed) {
    st.className = 'preview ok';
    st.textContent = `Connected · helper ${h.version} · yt-dlp ${h.ytdlp || 'missing'} · ffmpeg ${h.ffmpeg ? '✓' : 'missing'} · Deno ${h.deno ? '✓' : 'missing (needed for YouTube; run install.bat again)'}`;
    if (!h.ytdlp || !h.ffmpeg || !h.deno) st.className = 'preview bad';
  } else {
    st.className = 'preview bad';
    st.textContent = h.error === 'not installed' ? 'Not installed.' : `Not available: ${h.error}`;
  }
}

$('helperCheck').onclick = () => checkHelper(true);
$('helperUpdate').onclick = async () => {
  const out = $('helperOut');
  out.hidden = false;
  out.textContent = 'Updating yt-dlp…';
  const r = await sw({ type: 'MG_HELPER_UPDATE' }).catch((e) => ({ ok: false, error: e.message }));
  out.textContent = r?.ok ? r.data.output || 'Done.' : `Failed: ${r?.error}`;
  checkHelper(true);
};
