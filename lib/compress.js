// Bitrate limits for "worth compressing", quality steps, and size/bitrate formatting.
// The limit curve is log-log through the 720p, 1080p and 4K settings (kbps); below 720p
// the 720-1080 slope continues. Mirrored in helper/mediagrab-host.ps1 (Get-LimitKbps).

export function limitKbps(shortSide, a720 = 3000, a1080 = 5000, a2160 = 8000) {
  if (!(a720 > 0) || !(a1080 > a720)) { a720 = 3000; a1080 = 5000; }
  if (!(a2160 > a1080)) a2160 = 8000;
  const s = Math.max(144, shortSide);
  const k = s <= 1080 ? Math.log(a1080 / a720) / Math.log(1080 / 720) : Math.log(a2160 / a1080) / Math.log(2);
  return a1080 * Math.pow(s / 1080, k);
}

// est: { vkbps, w, h } -> true / false / null (unknown)
export function overLimit(est, prefs) {
  if (!est?.vkbps) return null;
  const short = Math.min(est.w || est.h || 0, est.h || est.w || 0);
  if (!short) return null;
  return est.vkbps > limitKbps(short, prefs.limit720, prefs.limit1080, prefs.limit2160);
}

export const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
export const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

const ENCODER_NAMES = { x265: 'x265 (CPU)', nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF' };
export const encoderName = (e) => ENCODER_NAMES[e] || e;

// Quality steps: every value on the x265 CRF scale from 20 (max) to 32 (tiny). The named
// presets are anchors; GPU encoders get values interpolated between their anchors.
// Mirrors Get-Quality in the helper.
const ANCHORS = [20, 22, 24, 27, 29, 32];
const PRESET_NAMES = { 20: 'Maximum: near-lossless', 22: 'High', 24: 'Balanced', 27: 'Smaller files', 29: 'Much smaller', 32: 'Tiny: visible softening' };
const OLD_NAMES = { max: 20, high: 22, balanced: 24, small: 27, smaller: 29, tiny: 32 };
export const QUALITY = {
  levels: Array.from({ length: 13 }, (_, i) => 20 + i),
  values: {
    x265: [20, 22, 24, 27, 29, 32],
    nvenc: [22, 24, 27, 30, 32, 35],
    qsv: [20, 22, 25, 28, 30, 33],
    amf: [20, 22, 25, 28, 30, 33],
  },
  scale: { x265: 'CRF', nvenc: 'CQ', qsv: 'quality', amf: 'QP' },
};

// Stored setting -> step number (accepts old preset names).
export const normalizeQuality = (q) => {
  if (OLD_NAMES[q] != null) return OLD_NAMES[q];
  const n = Number(q);
  return n >= 20 && n <= 32 ? Math.round(n) : 24;
};

export function qualityValue(level, enc) {
  const x = normalizeQuality(level);
  const t = QUALITY.values[enc] || QUALITY.values.x265;
  for (let i = 0; i < 5; i++) {
    if (x <= ANCHORS[i + 1]) return Math.round(t[i] + ((t[i + 1] - t[i]) * (x - ANCHORS[i])) / (ANCHORS[i + 1] - ANCHORS[i]));
  }
  return t[5];
}

export const qualityLabel = (level, enc) => {
  const x = normalizeQuality(level);
  const value = `${encoderName(enc)} ${QUALITY.scale[enc]} ${qualityValue(x, enc)}`;
  return PRESET_NAMES[x] ? `${PRESET_NAMES[x]} (${value})` : `   ${value}`;
};
