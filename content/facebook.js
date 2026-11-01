// Facebook: reels, video pages, photo pages and single posts (incl. group posts) only.
// Feeds are deliberately unsupported. Media comes from the page's embedded JSON and the
// GraphQL responses captured by inject/hook.js.
(() => {
  const MG = globalThis.MG;
  if (!MG || MG.site) return;
  MG.site = 'facebook';

  const media = new Map(); // id -> { kind, id, progressive[], xml, img, author, thumb }
  const reps = new Map(); // video id -> DASH representations
  const stories = []; // { urls: string[], ids: string[], author, text }

  const uniq = (a) => [...new Set(a.filter(Boolean))];

  function biggestImage(o) {
    let best = null;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object' && typeof v.uri === 'string' && v.width && v.height) {
        if (!best || v.width * v.height > best.w * best.h) best = { url: v.uri, w: v.width, h: v.height };
      }
    }
    return best;
  }

  // Record a Video/Photo object; returns its id if it is one.
  function noteMedia(o) {
    const id = o.id != null ? String(o.id) : '';
    if (!/^\d{6,}$/.test(id)) return null;
    const L = o.videoDeliveryLegacyFields || {};
    const R = o.videoDeliveryResponseFragment?.videoDeliveryResponseResult || {};
    const isVideo = o.__typename === 'Video' || o.playable_url || o.browser_native_hd_url || L.browser_native_hd_url ||
      L.browser_native_sd_url || o.playable_url_quality_hd || typeof o.dash_manifest === 'string' || R.progressive_urls;
    if (isVideo) {
      const m = media.get(id) || { kind: 'video', id, progressive: [] };
      const progHd = (R.progressive_urls || []).filter((p) => /hd/i.test(p?.metadata?.quality || '')).map((p) => p.progressive_url);
      const progSd = (R.progressive_urls || []).filter((p) => !/hd/i.test(p?.metadata?.quality || '')).map((p) => p.progressive_url);
      const hd = [L.browser_native_hd_url, o.browser_native_hd_url, o.playable_url_quality_hd, o.hd_src, ...progHd];
      const sd = [L.browser_native_sd_url, o.browser_native_sd_url, o.playable_url, o.sd_src, ...progSd];
      m.progressive = uniq([...hd, ...m.progressive, ...sd]);
      const xml = typeof o.dash_manifest === 'string' ? o.dash_manifest : R.dash_manifests?.[0]?.manifest_xml;
      if (typeof xml === 'string' && xml.includes('<MPD')) m.xml = xml;
      m.author ||= o.owner?.name || o.video_owner?.name || '';
      m.duration ||= Number(o.length_in_second) || (Number(o.playable_duration_in_ms) || 0) / 1000 || 0;
      m.thumb ||= o.preferred_thumbnail?.image?.uri || o.thumbnailImage?.uri || o.image?.uri || '';
      media.set(id, m);
      return id;
    }
    if (o.__typename === 'Photo') {
      const img = biggestImage(o);
      if (!img) return null;
      const m = media.get(id) || { kind: 'image', id };
      if (!m.img || img.w * img.h > m.img.w * m.img.h) m.img = img;
      m.author ||= o.owner?.name || '';
      media.set(id, m);
      return id;
    }
    return null;
  }

  MG.onJson = (json) => MG.walk(json, (o) => {
    noteMedia(o);
    if (o.video_id && Array.isArray(o.representations)) {
      reps.set(String(o.video_id), o.representations.filter((r) => r?.base_url).map((r) => ({
        type: /^audio/i.test(r.mime_type || '') ? 'audio' : 'video',
        url: r.base_url,
        br: r.bandwidth || 0,
        w: r.width || 0,
        h: r.height || 0,
        codec: r.codecs || '',
      })));
    }
    const urls = [o.url, o.wwwURL, o.permalink_url].filter((u) => typeof u === 'string');
    if (Array.isArray(o.attachments) && urls.length) {
      const ids = [];
      MG.walk(o.attachments, (c) => { const id = noteMedia(c); if (id && !ids.includes(id)) ids.push(id); });
      if (ids.length) {
        stories.push({
          urls,
          ids,
          author: o.actors?.[0]?.name || '',
          text: o.message?.text || o.comet_sections?.content?.story?.message?.text || '',
        });
      }
    }
  });
  const rescan = MG.scanScripts('script[type="application/json"]', /"Video"|"Photo"|representations|playable_url|browser_native/);

  // Which page are we on? Only single-item pages are supported.
  function pageRef(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const p = u.pathname;
    const q = (k) => u.searchParams.get(k);
    let m;
    if ((m = p.match(/^\/reel\/(\d+)/))) return { mediaId: m[1] };
    if (/^\/watch\/?$/.test(p) && q('v')) return { mediaId: q('v') };
    if (p === '/video.php' && q('v')) return { mediaId: q('v') };
    if ((m = p.match(/\/videos\/(?:[^/]+\/)?(\d{6,})/))) return { mediaId: m[1] };
    if (/^\/photo(\.php|\/)?$/.test(p) && q('fbid')) return { mediaId: q('fbid') };
    if ((m = p.match(/\/photos\/[^/]+\/(\d{6,})/))) return { mediaId: m[1] };
    if ((m = p.match(/^\/groups\/[^/]+\/(?:posts|permalink)\/(\w+)/))) return { post: m[1] };
    if ((m = p.match(/^\/[^/]+\/posts\/(\w+)/))) return { post: m[1] };
    if (/^\/(permalink|story)\.php$/.test(p) && q('story_fbid')) return { post: q('story_fbid') };
    return null;
  }

  function toItem(m, i, count, story) {
    const author = story?.author || m.author || '';
    const base = { site: 'facebook', postId: m.id, author, handleKind: 'name', desc: story?.text || '', index: i, count };
    if (m.kind === 'image') {
      return MG.item({ ...base, kind: 'image', thumb: m.img.url, label: `${m.img.w}×${m.img.h}`, source: { type: 'url', urls: [m.img.url], ext: 'jpg' } });
    }
    const r = reps.get(m.id) || [];
    if (!r.length && !m.xml && !m.progressive.length) return null;
    const top = r.filter((x) => x.type === 'video').reduce((a, x) => Math.max(a, Math.min(x.w || x.h, x.h || x.w)), 0);
    const short = (x) => Math.min(x.w || x.h, x.h || x.w);
    const bestV = r.filter((x) => x.type === 'video').sort((a, b) => short(b) - short(a) || b.br - a.br)[0];
    const bestA = r.filter((x) => x.type === 'audio').sort((a, b) => b.br - a.br)[0];
    const est = bestV ? MG.est({ vbps: bestV.br, abps: bestA?.br || 0, w: bestV.w, h: bestV.h, dur: m.duration || 0 }) : null;
    return MG.item({
      ...base, kind: 'video', thumb: m.thumb, est,
      label: top ? `${top}p` : m.progressive.length ? 'HD' : '',
      source: { type: 'fb', reps: r, xml: m.xml || null, progressive: m.progressive },
    });
  }

  function resolve(ref) {
    let ids = [];
    let story = null;
    if (ref.mediaId) {
      ids = [ref.mediaId];
      story = stories.find((s) => s.ids.includes(ref.mediaId)) || null;
    } else {
      const matches = stories.filter((s) => s.urls.some((u) => u.includes(ref.post)));
      story = matches.sort((a, b) => b.ids.length - a.ids.length)[0] || null;
      ids = story?.ids || [];
    }
    const found = ids.map((id) => media.get(id)).filter(Boolean);
    const items = found.map((m, i) => toItem(m, i, found.length, story)).filter(Boolean);
    return {
      postId: ref.mediaId || ref.post,
      author: story?.author || found[0]?.author || '',
      title: (story?.text || '').slice(0, 140),
      items,
      error: items.length ? undefined : 'No media found for this post yet. Reload the page (or play the video once) and retry.',
    };
  }

  const NOT_HERE = 'Open a reel, video, photo or single post. Facebook feeds aren\'t supported.';

  MG.list = async () => {
    rescan();
    const ref = pageRef(location.href);
    if (!ref) throw new Error(NOT_HERE);
    return [resolve(ref)];
  };

  MG.context = async ({ srcUrl }) => {
    rescan();
    const ref = pageRef(location.href);
    if (!ref) throw new Error(NOT_HERE);
    const post = resolve(ref);
    // Right-clicked an image we couldn't map: save what's displayed.
    if (!post.items.length && /fbcdn\.net/.test(srcUrl || '')) {
      post.items = [MG.item({ site: 'facebook', postId: post.postId, author: post.author, handleKind: 'name', desc: post.title, index: 0, count: 1, kind: 'image', source: { type: 'url', urls: [srcUrl], ext: 'jpg' } })];
    }
    return [post];
  };
})();
