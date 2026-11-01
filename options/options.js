import { DEFAULTS, getSettings, buildName } from '../lib/settings.js';
import { limitKbps, encoderName, QUALITY, qualityLabel } from '../lib/compress.js';
import { helperOutdated, MIN_HELPER } from '../lib/helper.js';

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
  const lim = (h) => Math.round(limitKbps(h, s.limit720, s.limit1080) / 100) * 100;
  $('limitPreview').textContent = `Videos above these bitrates count as "worth compressing". Other resolutions follow the same curve: 480p ${lim(480)} · 1440p ${lim(1440)} · 4K ${lim(2160)} kbps.`;
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
  relabelQuality();
  $('encoder').addEventListener('change', relabelQuality);
  checkHelper(true).then(detectEncoders);
})();

// Quality options show the exact value for the encoder that will actually run
// (with Auto: the first working graphics-card encoder, else x265).
let detected = null;
function relabelQuality() {
  const choice = $('encoder').value;
  const enc = choice !== 'auto' ? choice : (['nvenc', 'qsv', 'amf'].find((k) => detected?.[k]) || 'x265');
  for (const opt of $('quality').options) {
    if (QUALITY.presets.includes(opt.value)) opt.textContent = qualityLabel(opt.value, enc);
  }
}

// Which HEVC encoders work on this PC (the helper test-encodes once and caches it).
async function detectEncoders(installed) {
  const out = $('encDetected');
  if (!installed) { out.textContent = 'Install the helper to compress videos.'; return; }
  const r = await sw({ type: 'MG_HELPER_ENCODERS' }).catch((e) => ({ ok: false, error: e.message }));
  if (!r) { out.textContent = "Couldn't detect encoders: MediaGrab's background didn't answer. Reload the extension in chrome://extensions."; return; }
  if (!r.ok) {
    const old = /unknown command/i.test(r.error || '');
    out.textContent = old ? 'Couldn\'t detect encoders: the helper is out of date. Run helper\\install.bat again.' : `Couldn't detect encoders: ${r.error || 'unknown error'}`;
    return;
  }
  const e = r.data || {};
  detected = e;
  relabelQuality();
  const gpus = ['nvenc', 'qsv', 'amf'].filter((k) => e[k]);
  out.textContent = `Detected on this PC: ${[...gpus.map(encoderName), e.x265 ? encoderName('x265') : null].filter(Boolean).join(' · ') || 'none'}. ` +
    `Auto uses ${gpus.length ? encoderName(gpus[0]) : 'x265 (CPU)'}.`;
}

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
    if (helperOutdated(h.version)) st.textContent += ` · helper ${MIN_HELPER}+ needed for compression: run install.bat again`;
    if (!h.ytdlp || !h.ffmpeg || !h.deno || helperOutdated(h.version)) st.className = 'preview bad';
  } else {
    st.className = 'preview bad';
    st.textContent = h.error === 'not installed' ? 'Not installed.' : `Not available: ${h.error}`;
  }
  return h.installed;
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
