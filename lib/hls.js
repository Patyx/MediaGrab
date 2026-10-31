// Minimal HLS support for X: master playlist parsing and fMP4 segment playlists
// (EXT-X-MAP init + .m4s segments). MPEG-TS playlists are reported as unsupported.

const attrs = (line) => {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
};
const abs = (u, base) => new URL(u, base).href;

export function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const audio = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) {
        (audio[a['GROUP-ID']] ||= []).push({ url: abs(a.URI, base), br: parseInt((a['GROUP-ID'] || '').match(/\d+/)?.[0] || '0', 10), isDefault: a.DEFAULT === 'YES' });
      }
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) break;
      const [w, h] = (a.RESOLUTION || '0x0').split('x').map(Number);
      variants.push({
        url: abs(lines[j], base),
        br: Number(a.BANDWIDTH) || 0,
        w, h,
        codec: (a.CODECS || '').split(',').find((c) => !/^mp4a|^opus|^ac-3|^ec-3/i.test(c.trim()))?.trim() || '',
        muxedAudio: /mp4a|opus/i.test(a.CODECS || '') && !a.AUDIO,
        audioGroup: a.AUDIO || null,
      });
      i = j;
    }
  }
  return { variants, audio };
}

export function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let init = null;
  const segments = [];
  let byterange = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP:')) init = abs(attrs(l.slice(11)).URI, base);
    else if (l.startsWith('#EXT-X-BYTERANGE')) byterange = true;
    else if (l && !l.startsWith('#')) segments.push(abs(l, base));
  }
  const ts = !init || segments.some((s) => /\.ts(\?|$)/i.test(s));
  return { init, segments, byterange, ts };
}
