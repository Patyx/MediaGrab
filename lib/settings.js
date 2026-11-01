// User settings (chrome.storage.sync) and the filename builder that uses them.

export const DEFAULTS = {
  // filenames
  separator: ' - ',
  descLength: 45,
  prefixHandles: false, // r_videos / @user
  suffixStyle: '_n', // '_n' | ' (n)' | ' n'
  // saving
  saveAs: true,
  folder: 'MediaGrab', // used when saveAs is off (relative to Downloads)
  // quality
  maxHeight: 0, // 0 = no cap; otherwise 2160 / 1440 / 1080 / 720 / 480 (short side)
  preferH264: false,
  xHls: true,
  // helper (Windows, optional)
  useHelper: true, // save through the helper's Save dialog (opens at the last folder used)
  audioFormat: 'mp3', // 'mp3' (yt-dlp via helper) | 'm4a' (built in, original audio)
  mp3Quality: '0', // yt-dlp --audio-quality: '0' best VBR, or '320K' / '192K' / '128K'
  // compression (HEVC via the helper's ffmpeg)
  autoCompress: true, // pre-tick "Compress to HEVC" for videos over the limit
  limit720: 3000, // kbps: video bitrate above this at 720p is worth compressing
  limit1080: 5000, // kbps at 1080p
  limit2160: 8000, // kbps at 4K (other resolutions follow the curve through these three)
  encoder: 'auto', // 'auto' (GPU if available, else CPU) | 'x265' | 'nvenc' | 'qsv' | 'amf'
  quality: '24', // step on the x265 CRF scale, '20' (max) … '32' (tiny); old preset names still accepted
  x265Preset: 'slow', // CPU encoder speed: 'medium' | 'slow' | 'slower'
  minSavings: 15, // % — keep the original if compression saves less than this
  audioCompress: true, // when compressing video, also re-encode audio above audioLimit
  audioLimit: 200, // kbps
  audioTarget: 128, // kbps AAC
};

export async function getSettings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

// Characters Chrome/Windows/macOS accept in a filename; links dropped.
export const fileSafe = (s) => String(s || '')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/[<>:"/\\|?*~\p{Cc}\p{Cf}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();
const trimEnds = (s) => s.trim().replace(/[.\s]+$/, '');

// n = { site, handle, handleKind: 'subreddit'|'user'|'name', desc, postId, index, count }
export function buildName(n, s) {
  const prefix = s.prefixHandles ? (n.handleKind === 'subreddit' ? 'r_' : n.handleKind === 'user' ? '@' : '') : '';
  const handle = trimEnds(fileSafe(n.handle));
  const len = Math.max(0, Math.min(200, Number(s.descLength) || 0));
  const desc = trimEnds(Array.from(fileSafe(n.desc)).slice(0, len).join('')) || fileSafe(n.postId);
  const sep = fileSafe(s.separator) ? s.separator.replace(/[<>:"/\\|?*~]/g, '') : ' ';
  let suffix = '';
  if (n.count > 1) {
    const k = n.index + 1;
    suffix = s.suffixStyle === ' (n)' ? ` (${k})` : s.suffixStyle === ' n' ? ` ${k}` : `_${k}`;
  }
  return `${handle ? prefix + handle : n.site}${sep}${desc}${suffix}`;
}

export const cleanFolder = (f) => String(f || '')
  .split(/[\\/]+/)
  .map((p) => trimEnds(fileSafe(p)))
  .filter((p) => p && p !== '..')
  .join('/');
