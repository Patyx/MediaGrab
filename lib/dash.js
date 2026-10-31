// Pick the best video and audio representations from a DASH manifest.
// Only "one file per representation" manifests (SegmentBase + BaseURL) are supported,
// which is what Reddit (v.redd.it), Instagram and Facebook serve.
import { pickVideo, pickAudio } from './pick.js';

export function dashReps(xml, manifestUrl) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('bad DASH manifest');

  const resolve = (rel, base) => {
    try { return new URL(rel, base || undefined).href; } catch { return rel; }
  };
  const baseOf = (el, inherited) => {
    for (const c of el.children) if (c.localName === 'BaseURL') return resolve(c.textContent.trim(), inherited);
    return inherited;
  };
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);

  const mpd = doc.documentElement;
  const root = baseOf(mpd, manifestUrl || '');
  const reps = [];
  for (const period of kids(mpd, 'Period')) {
    const pBase = baseOf(period, root);
    for (const as of kids(period, 'AdaptationSet')) {
      const aBase = baseOf(as, pBase);
      const asType = (as.getAttribute('contentType') || as.getAttribute('mimeType') || '').split('/')[0];
      for (const rep of kids(as, 'Representation')) {
        if (!kids(rep, 'BaseURL').length) continue; // segment templates not supported
        const attr = (n) => rep.getAttribute(n) || as.getAttribute(n) || '';
        const codec = attr('codecs');
        let type = asType || attr('mimeType').split('/')[0];
        if (type !== 'video' && type !== 'audio') type = /mp4a|opus|ac-3|ec-3|flac/i.test(codec) ? 'audio' : 'video';
        reps.push({
          type,
          url: baseOf(rep, aBase),
          br: Number(rep.getAttribute('bandwidth')) || 0,
          w: Number(attr('width')) || 0,
          h: Number(attr('height')) || 0,
          codec,
        });
      }
    }
  }
  return reps;
}

export function chooseReps(reps, prefs) {
  return {
    video: pickVideo(reps.filter((r) => r.type === 'video'), prefs),
    audio: pickAudio(reps.filter((r) => r.type === 'audio')),
  };
}

export const parseDash = (xml, manifestUrl, prefs) => chooseReps(dashReps(xml, manifestUrl), prefs);
