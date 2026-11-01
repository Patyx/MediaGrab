// X / Twitter: media comes from GraphQL responses the page already loaded (captured by
// inject/hook.js); falls back to the public syndication endpoint for anything not seen yet.
(() => {
  const MG = globalThis.MG;
  if (!MG || MG.site) return;
  MG.site = 'x';

  const cache = new Map(); // tweet id -> { id, author, media, quotedId, text }
  const idFromUrl = (u) => (String(u || '').match(/\/status(?:es)?\/(\d+)/) || [])[1] || null;

  function remember(id, author, media, quotedId, text) {
    const p = cache.get(id) || { id, media: [] };
    cache.set(id, {
      id,
      author: author || p.author,
      media: media?.length ? media : p.media,
      quotedId: quotedId || p.quotedId,
      text: text || p.text,
    });
  }

  MG.onJson = (json) => MG.walk(json, (o) => {
    if (typeof o.rest_id === 'string' && o.legacy && typeof o.legacy === 'object' &&
        ('full_text' in o.legacy || o.legacy.extended_entities)) {
      const u = o.core?.user_results?.result;
      remember(o.rest_id, u?.legacy?.screen_name || u?.core?.screen_name,
        o.legacy.extended_entities?.media, o.legacy.quoted_status_id_str, o.legacy.full_text);
    } else if (typeof o.id_str === 'string' && o.extended_entities?.media) {
      remember(o.id_str, o.user?.screen_name, o.extended_entities.media, o.quoted_status_id_str, o.full_text || o.text);
    }
  });

  function twimg(u, name) {
    const url = new URL(u);
    const ext = (url.pathname.match(/\.(\w+)$/) || [])[1] || 'jpg';
    return { url: `${url.origin}${url.pathname.replace(/\.\w+$/, '')}?format=${ext}&name=${name}`, ext };
  }

  function itemsFor(t) {
    const media = t.media || [];
    return media.map((m, i) => {
      const base = { site: 'x', postId: t.id, author: t.author, desc: t.text, index: i, count: media.length, postUrl: `https://x.com/${t.author || 'i'}/status/${t.id}` };
      const thumb = m.media_url_https ? twimg(m.media_url_https, 'small').url : '';
      if (m.type === 'photo') {
        const { url, ext } = twimg(m.media_url_https, 'orig');
        const oi = m.original_info;
        return MG.item({ ...base, kind: 'image', thumb, label: oi ? `${oi.width}×${oi.height}` : '', source: { type: 'url', urls: [url, m.media_url_https], ext } });
      }
      const all = m.video_info?.variants || [];
      const vs = all
        .filter((v) => v.content_type === 'video/mp4' && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!vs.length) return null;
      const hls = all.find((v) => /mpegurl/i.test(v.content_type || '') && v.url)?.url || null;
      const variants = vs.map((v) => {
        const r = v.url.match(/\/(\d+)x(\d+)\//);
        return { url: v.url, br: v.bitrate || 0, w: r ? +r[1] : 0, h: r ? +r[2] : 0 };
      });
      const top = variants[0];
      const gif = m.type === 'animated_gif';
      const label = gif ? 'GIF' : top.h ? `${Math.min(top.w, top.h)}p${hls ? '+' : ''}` : '';
      const dur = (m.video_info?.duration_millis || 0) / 1000;
      const est = MG.est({ vbps: top.br, abps: gif ? 0 : 128000, w: top.w, h: top.h, dur });
      return MG.item({ ...base, kind: 'video', thumb, label, est, source: { type: 'x', variants, hls, gif } });
    }).filter(Boolean);
  }

  async function syndication(id) {
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const j = await MG.bgFetchJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`);
    if (!j || j.__typename === 'TweetTombstone') {
      throw new Error('Not available via the public API (age-restricted or protected). Scroll it into view while logged in, reload, and retry.');
    }
    const main = j.mediaDetails?.length ? j : j.quoted_tweet?.mediaDetails?.length ? j.quoted_tweet : j;
    const t = { id: main.id_str || id, author: main.user?.screen_name, media: main.mediaDetails || [], text: main.text };
    remember(t.id, t.author, t.media, null, t.text);
    return t;
  }

  async function resolve(id) {
    let t = cache.get(id);
    if (!t?.media.length) {
      const q = t?.quotedId && cache.get(t.quotedId);
      if (q?.media.length) t = q;
      else {
        try { t = await syndication(id); } catch (e) { if (!t) throw e; }
      }
    }
    return {
      postId: id,
      author: t?.author ? `@${t.author}` : '',
      title: (t?.text || '').slice(0, 140),
      items: t ? itemsFor(t) : [],
      error: t?.media.length ? undefined : 'No media in this post',
    };
  }

  const tweetIdFromArticle = (art) => {
    const a = art.querySelector('a[href*="/status/"] time')?.closest('a') || art.querySelector('a[href*="/status/"]');
    return idFromUrl(a?.getAttribute('href'));
  };

  const safe = (id) => resolve(id).catch((e) => ({ postId: id, items: [], error: e.message }));

  MG.list = async () => {
    const here = idFromUrl(location.pathname);
    const ids = here ? [here] : MG.visible([...document.querySelectorAll('article')]).map(tweetIdFromArticle);
    const out = await Promise.all([...new Set(ids.filter(Boolean))].map(safe));
    return here ? out : out.filter((p) => p.items.length);
  };

  MG.context = async ({ linkUrl }) => {
    let id = idFromUrl(linkUrl);
    if (!id) {
      const art = MG.contextPath().find((el) => el.tagName === 'ARTICLE');
      id = art && tweetIdFromArticle(art);
    }
    id ||= idFromUrl(location.pathname);
    if (!id) throw new Error('Could not find a post here');
    return [await resolve(id)];
  };
})();
