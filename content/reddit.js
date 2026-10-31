// Reddit: resolves posts through Reddit's own JSON API (same-origin, uses your login).
(() => {
  const MG = globalThis.MG;
  if (!MG || MG.site) return;
  MG.site = 'reddit';

  const IMG_EXT = { 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

  const idFromUrl = (u) => (String(u || '').match(/\/comments\/([a-z0-9]+)/i) || [])[1] || null;
  const idFromEl = (el) => {
    if (!el?.matches) return null;
    if (el.matches('shreddit-post')) {
      return (el.id || '').replace(/^t3_/, '') || idFromUrl(el.getAttribute('permalink'));
    }
    if (el.matches('.thing[data-fullname^="t3_"]')) return el.getAttribute('data-fullname').slice(3);
    return null;
  };

  const sameOrigin = async (path) => {
    const r = await fetch(path, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${path.split('?')[0]}`);
    return r.json();
  };

  // Reddit refuses some JSON routes depending on login/region/VPN, so try several.
  async function fetchPosts(ids) {
    const names = ids.map((i) => 't3_' + i).join(',');
    const routes = [
      ['by_id', () => sameOrigin(`/by_id/${names}.json?raw_json=1`)],
      ['comments', async () => ({
        data: { children: (await Promise.all(ids.map((id) => sameOrigin(`/comments/${id}.json?raw_json=1&limit=1`)))).flatMap((j) => j?.[0]?.data?.children || []) },
      })],
      ['api.reddit.com', () => MG.bgFetchJson(`https://api.reddit.com/api/info/?id=${names}&raw_json=1`)],
      ['old.reddit.com', () => MG.bgFetchJson(`https://old.reddit.com/by_id/${names}.json?raw_json=1`)],
    ];
    const errors = [];
    for (const [name, run] of routes) {
      try {
        const children = (await run())?.data?.children || [];
        if (!children.length) throw new Error('empty response');
        console.debug(`[MediaGrab] Reddit data via ${name}`);
        const byId = new Map(children.map((c) => [c.data.id, c.data]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    console.warn('[MediaGrab] all Reddit API routes failed', errors);
    throw new Error(`Reddit API refused (${errors[0]})`);
  }

  // Last resort: read the post straight from the page markup.
  function fromDom(id) {
    const el = document.querySelector(`shreddit-post[id="t3_${id}"], .thing[data-fullname="t3_${id}"]`);
    if (!el) return null;
    const author = el.getAttribute('author') || el.getAttribute('data-author') || '';
    const title = el.getAttribute('post-title') || el.querySelector('a.title')?.textContent || '';
    const href = el.getAttribute('content-href') || el.getAttribute('data-url') || '';
    const player = el.querySelector('shreddit-player-2, shreddit-player, [data-mpd-url], [data-hls-url]');
    const playerSrc = player
      ? [player.getAttribute('src'), player.getAttribute('data-mpd-url'), player.getAttribute('data-hls-url'), player.getAttribute('packaged-media-json')].join(' ')
      : '';
    const vid = ((href + ' ' + playerSrc).match(/v\.redd\.it\/([a-z0-9]+)/i) || [])[1];
    const raw = [];
    const ext = externalSource(href);
    const direct = href.match(/^https?:\/\/(?:i|preview)\.redd\.it\/[^?#]+\.(jpe?g|png|gif|webp)/i);
    if (vid) {
      raw.push({ kind: 'video', label: 'best quality', source: { type: 'reddit', dash: `https://v.redd.it/${vid}/DASHPlaylist.mpd`, vid, fallback: null, hasAudio: true } });
    } else if (ext) {
      raw.push(ext);
    } else if (direct) {
      raw.push({ kind: 'image', thumb: href, source: { type: 'url', urls: [href], ext: direct[1].toLowerCase().replace('jpeg', 'jpg'), fetch: true } });
    } else {
      const seen = new Set();
      for (const img of el.querySelectorAll('gallery-carousel img, figure img, img[src*="redd.it"]')) {
        const src = img.getAttribute('src') || img.getAttribute('data-lazy-src') || '';
        const m = src.match(/redd\.it\/(?:[^?#]*-v0-)?([a-z0-9]{8,20})\.(jpe?g|png|gif|webp)/i);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const e = m[2].toLowerCase().replace('jpeg', 'jpg');
        raw.push({ kind: 'image', thumb: src, source: { type: 'url', urls: [`https://i.redd.it/${m[1]}.${e}`, src], ext: e, fetch: true } });
      }
    }
    const subreddit = el.getAttribute('subreddit-name') ||
      (el.getAttribute('subreddit-prefixed-name') || '').replace(/^r\//, '') ||
      el.getAttribute('data-subreddit') || '';
    const permalink = el.getAttribute('permalink') || el.getAttribute('data-permalink') || `/comments/${id}/`;
    const base = { site: 'reddit', postId: id, author, handle: subreddit, handleKind: 'subreddit', desc: title, postUrl: new URL(permalink, 'https://www.reddit.com').href };
    return {
      postId: id,
      author: author ? `u/${author}` : '',
      title,
      items: raw.map((r, i) => MG.item({ ...base, ...r, index: i, count: raw.length })),
    };
  }

  async function resolveIds(ids) {
    let apiErr = null;
    let posts = [];
    try { posts = await fetchPosts(ids); } catch (e) { apiErr = e; }
    const byId = new Map(posts.map((p) => [p.id, toResult(p)]));
    const out = ids.map((id) => byId.get(id) || fromDom(id)).filter(Boolean);
    if (!out.length && apiErr) throw apiErr;
    return out;
  }

  function externalSource(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const h = u.hostname.replace(/^www\./, '');
    if (/(^|\.)redgifs\.com$/.test(h)) {
      const id = (u.pathname.match(/\/(?:watch|ifr|i)\/([a-z0-9]+)/i) || [])[1];
      return id ? { kind: 'video', label: 'Redgifs', source: { type: 'redgifs', id: id.toLowerCase() } } : null;
    }
    if (/(^|\.)imgur\.com$/.test(h)) {
      if (/^\/(a|gallery)\//.test(u.pathname)) return null;
      const vid = /\.(gifv|mp4|webm|gif)$/i.test(u.pathname);
      return { kind: vid ? 'video' : 'image', label: 'Imgur', source: { type: 'imgur', url: u.href } };
    }
    if (/(^|\.)streamable\.com$/.test(h)) {
      const id = (u.pathname.match(/^\/(?:[eo]\/)?([a-z0-9]+)/i) || [])[1];
      return id ? { kind: 'video', label: 'Streamable', source: { type: 'streamable', id } } : null;
    }
    return null;
  }

  function toResult(post) {
    const src = post.crosspost_parent_list?.[0] || post;
    const thumb = /^https?:/.test(src.thumbnail || '') ? src.thumbnail : '';
    const raw = [];
    const rv = src.secure_media?.reddit_video || src.media?.reddit_video;

    if (rv) {
      raw.push({
        kind: 'video',
        label: rv.height ? `${rv.height}p` : '',
        thumb,
        source: { type: 'reddit', dash: rv.dash_url, fallback: rv.fallback_url, hasAudio: rv.has_audio !== false && !rv.is_gif },
      });
    } else if (src.is_gallery && src.gallery_data?.items) {
      for (const g of src.gallery_data.items) {
        const m = src.media_metadata?.[g.media_id];
        if (!m || m.status !== 'valid') continue;
        const t = m.p?.[0]?.u || '';
        if (m.e === 'Image') {
          const ext = IMG_EXT[m.m] || 'jpg';
          raw.push({
            kind: 'image', thumb: t, label: m.s?.x ? `${m.s.x}×${m.s.y}` : '',
            source: { type: 'url', urls: [`https://i.redd.it/${g.media_id}.${ext}`, m.s?.u].filter(Boolean), ext, fetch: true },
          });
        } else if (m.e === 'AnimatedImage') {
          raw.push({
            kind: 'image', thumb: t, label: 'GIF',
            source: { type: 'url', urls: [m.s?.gif && `https://i.redd.it/${g.media_id}.gif`, m.s?.mp4].filter(Boolean), ext: m.s?.gif ? 'gif' : 'mp4', fetch: true },
          });
        } else if (m.e === 'RedditVideo' && m.dashUrl) {
          raw.push({ kind: 'video', thumb: t, source: { type: 'reddit', dash: m.dashUrl, fallback: null, hasAudio: true } });
        }
      }
    } else {
      const url = src.url_overridden_by_dest || src.url || '';
      const ext = externalSource(url);
      const direct = url.match(/^https?:\/\/(?:i|preview)\.redd\.it\/[^?#]+\.(jpe?g|png|gif|webp)/i);
      const previewImg = src.preview?.images?.[0]?.source;
      if (ext) {
        raw.push({ ...ext, thumb });
      } else if (direct) {
        raw.push({ kind: 'image', thumb, label: previewImg ? `${previewImg.width}×${previewImg.height}` : '', source: { type: 'url', urls: [url], ext: direct[1].toLowerCase().replace('jpeg', 'jpg'), fetch: true } });
      } else if (src.preview?.reddit_video_preview?.fallback_url) {
        const p = src.preview.reddit_video_preview;
        raw.push({ kind: 'video', thumb, label: `${p.height}p (no audio)`, source: { type: 'url', urls: [p.fallback_url], ext: 'mp4', fetch: true } });
      } else if (src.post_hint === 'image' && previewImg?.url) {
        raw.push({ kind: 'image', thumb, label: `${previewImg.width}×${previewImg.height}`, source: { type: 'url', urls: [previewImg.url], ext: 'jpg', fetch: true } });
      }
    }

    const base = { site: 'reddit', postId: post.id, author: src.author, handle: post.subreddit, handleKind: 'subreddit', desc: post.title, postUrl: `https://www.reddit.com${post.permalink}` };
    return {
      postId: post.id,
      author: src.author ? `u/${src.author}` : '',
      title: post.title,
      items: raw.map((r, i) => MG.item({ ...base, ...r, index: i, count: raw.length })),
    };
  }

  MG.list = async () => {
    const here = idFromUrl(location.pathname);
    const ids = here
      ? [here]
      : MG.visible([...document.querySelectorAll('shreddit-post, .thing.link[data-fullname]')]).map(idFromEl);
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    const results = await resolveIds(unique);
    return here ? results : results.filter((p) => p.items.length);
  };

  MG.context = async ({ linkUrl }) => {
    let id = idFromUrl(linkUrl);
    if (!id) for (const el of MG.contextPath()) if ((id = idFromEl(el))) break;
    id ||= idFromUrl(location.pathname);
    if (!id) throw new Error('Could not find a Reddit post here');
    return resolveIds([id]);
  };
})();
