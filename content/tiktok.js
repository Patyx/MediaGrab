// TikTok: item data from the page's rehydration JSON and captured API responses
// (feeds), falling back to fetching the video page and reading its embedded JSON.
(() => {
  const MG = globalThis.MG;
  if (!MG || MG.site) return;
  MG.site = 'tiktok';

  const cache = new Map(); // video id -> item struct
  const isItem = (o) => typeof o.id === 'string' && /^\d{15,25}$/.test(o.id) &&
    ((o.video && (o.video.playAddr || o.video.bitrateInfo)) || o.imagePost);

  MG.onJson = (json) => MG.walk(json, (o) => { if (isItem(o)) cache.set(o.id, o); });
  const DATA_SCRIPTS = 'script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE, script#__NEXT_DATA__';
  MG.scanScripts(DATA_SCRIPTS);

  const idFromUrl = (u) => (String(u || '').match(/\/(?:video|photo)\/(\d{15,25})/) || [])[1] || null;
  const authorFromUrl = (u) => (String(u || '').match(/\/@([\w.-]+)\/(?:video|photo)\//) || [])[1] || null;

  // Walk up from an element until something identifies exactly one video.
  function refFromEl(start) {
    let el = start;
    for (let depth = 0; el && depth < 15; depth++) {
      const m = (el.id || '').match(/xgwrapper-\d+-(\d{15,25})/);
      if (m) return { id: m[1] };
      if (el.querySelectorAll) {
        const found = new Map();
        for (const a of el.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')) {
          const id = idFromUrl(a.href);
          if (id) found.set(id, authorFromUrl(a.href));
        }
        if (found.size === 1) { const [[id, author]] = found; return { id, author }; }
        if (found.size > 1) return null;
      }
      el = el.parentElement || el.getRootNode?.().host;
    }
    return null;
  }

  async function fromPage({ id, author }) {
    const r = await fetch(`/@${author || ''}/video/${id}`, { credentials: 'include' });
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    for (const s of doc.querySelectorAll(DATA_SCRIPTS)) {
      try { MG.onJson(JSON.parse(s.textContent)); } catch {}
    }
    const it = cache.get(id);
    if (!it) throw new Error('Video data not found. Open the video itself and retry.');
    return it;
  }

  function toResult(it) {
    const author = it.author?.uniqueId || (typeof it.author === 'string' ? it.author : '');
    const base = { site: 'tiktok', postId: it.id, author, desc: it.desc, postUrl: `https://www.tiktok.com/@${author}/video/${it.id}` };
    const head = { postId: it.id, author: author ? `@${author}` : '', title: (it.desc || '').slice(0, 140) };

    const imgs = it.imagePost?.images;
    if (imgs?.length) {
      return {
        ...head,
        items: imgs.map((im, i) => {
          const urls = im.imageURL?.urlList || [];
          const jpg = urls.filter((u) => /\.jpe?g/i.test(u));
          return MG.item({
            ...base, kind: 'image', index: i, count: imgs.length, thumb: urls[0],
            label: im.imageWidth ? `${im.imageWidth}×${im.imageHeight}` : '',
            source: { type: 'url', urls: [...jpg, ...urls.filter((u) => !jpg.includes(u))], ext: 'jpg', fetch: true },
          });
        }),
      };
    }

    const v = it.video || {};
    const cands = [];
    for (const b of v.bitrateInfo || []) {
      const pa = b.PlayAddr || {};
      if (pa.UrlList?.length) cands.push({ w: pa.Width || 0, h: pa.Height || 0, br: b.Bitrate || 0, codec: b.CodecType || '', urls: pa.UrlList });
    }
    if (v.playAddr) cands.push({ w: v.width || 0, h: v.height || 0, br: v.bitrate || 0, codec: v.codecType || '', urls: [v.playAddr] });
    cands.sort((a, b) => b.w * b.h - a.w * a.h || b.br - a.br);
    if (!cands.length) return { ...head, items: [], error: 'No playable video URL (login or age gate?)' };

    const best = cands[0];
    return {
      ...head,
      items: [MG.item({
        ...base, kind: 'video', index: 0, count: 1,
        thumb: v.cover || v.originCover || '',
        label: best.h ? `${Math.min(best.w || best.h, best.h)}p` : '',
        // The offscreen worker picks the stream using the quality settings.
        source: { type: 'tiktok', cands },
      })],
    };
  }

  const resolve = async (ref) => {
    try {
      return toResult(cache.get(ref.id) || (await fromPage(ref)));
    } catch (e) {
      return { postId: ref.id, items: [], error: e.message };
    }
  };

  MG.list = async () => {
    const hereId = idFromUrl(location.pathname);
    let refs = [];
    if (hereId) refs = [{ id: hereId, author: authorFromUrl(location.pathname) }];
    else {
      refs = MG.visible([...document.querySelectorAll('video')], 3).map(refFromEl).filter(Boolean);
      if (!refs.length) {
        refs = MG.visible([...document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')])
          .map((a) => ({ id: idFromUrl(a.href), author: authorFromUrl(a.href) }));
      }
    }
    const out = await Promise.all(MG.uniqueBy(refs, (r) => r.id).map(resolve));
    return hereId ? out : out.filter((p) => p.items.length);
  };

  MG.context = async ({ linkUrl }) => {
    let ref = idFromUrl(linkUrl) ? { id: idFromUrl(linkUrl), author: authorFromUrl(linkUrl) } : null;
    if (!ref) for (const el of MG.contextPath()) if ((ref = refFromEl(el))) break;
    if (!ref && idFromUrl(location.pathname)) ref = { id: idFromUrl(location.pathname), author: authorFromUrl(location.pathname) };
    if (!ref) throw new Error('Could not find a TikTok video here');
    return [await resolve(ref)];
  };
})();
