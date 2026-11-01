// Bitrate limits for "worth compressing" and size/bitrate formatting.
// The limit curve passes through the 720p and 1080p settings (kbps) and follows the
// same exponent for other resolutions; it's mirrored in helper/mediagrab-host.ps1.

export function limitKbps(shortSide, a720 = 3000, a1080 = 5000) {
  if (!(a720 > 0) || !(a1080 > a720)) { a720 = 3000; a1080 = 5000; }
  const k2 = (2 * Math.log(a1080 / a720)) / Math.log(2.25);
  return a1080 * Math.pow(Math.max(144, shortSide) / 1080, k2);
}

// est: { vkbps, w, h } -> true / false / null (unknown)
export function overLimit(est, prefs) {
  if (!est?.vkbps) return null;
  const short = Math.min(est.w || est.h || 0, est.h || est.w || 0);
  if (!short) return null;
  return est.vkbps > limitKbps(short, prefs.limit720, prefs.limit1080);
}

export const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
export const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

// Exact quality value each preset uses per encoder (mirrors Get-Quality in the helper).
export const QUALITY = {
  presets: ['max', 'high', 'balanced', 'small', 'smaller', 'tiny'],
  names: { max: 'Maximum: near-lossless', high: 'High', balanced: 'Balanced', small: 'Smaller files', smaller: 'Much smaller', tiny: 'Tiny: visible softening' },
  values: {
    x265: [20, 22, 24, 27, 29, 32],
    nvenc: [22, 24, 27, 30, 32, 35],
    qsv: [20, 22, 25, 28, 30, 33],
    amf: [20, 22, 25, 28, 30, 33],
  },
  scale: { x265: 'CRF', nvenc: 'CQ', qsv: 'quality', amf: 'QP' },
};
export const qualityLabel = (preset, enc) => {
  const i = QUALITY.presets.indexOf(preset);
  return `${QUALITY.names[preset]} (${encoderName(enc)} ${QUALITY.scale[enc]} ${QUALITY.values[enc][i]})`;
};

const ENCODER_NAMES = { x265: 'x265 (CPU)', nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF' };
export const encoderName = (e) => ENCODER_NAMES[e] || e;
