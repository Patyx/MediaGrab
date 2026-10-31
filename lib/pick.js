// Choose the best video candidate under the user's quality preferences.
// Candidate: { w, h, br, codec, ... }. Resolution is compared on the short side
// (so a 1080x1920 reel counts as 1080p).

export const res = (c) => (c ? Math.min(c.w || c.h || 0, c.h || c.w || 0) : 0);
export const isH264 = (codec) => !codec || /^(avc|h264)/i.test(codec);

export function pickVideo(cands, prefs = {}) {
  let pool = cands.filter(Boolean);
  if (prefs.maxHeight) {
    const capped = pool.filter((c) => !res(c) || res(c) <= prefs.maxHeight);
    if (capped.length) pool = capped;
  }
  if (prefs.preferH264) {
    const avc = pool.filter((c) => isH264(c.codec));
    if (avc.length) pool = avc;
  }
  // Highest resolution; at equal resolution prefer H.264 (plays everywhere), then bitrate.
  return [...pool].sort((a, b) =>
    res(b) - res(a) || Number(isH264(b.codec)) - Number(isH264(a.codec)) || (b.br || 0) - (a.br || 0))[0] || null;
}

export const pickAudio = (cands) => [...cands].sort((a, b) => (b.br || 0) - (a.br || 0))[0] || null;
