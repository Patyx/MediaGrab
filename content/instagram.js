// Instagram: media objects from captured API responses / embedded page JSON, falling back
// to the web API (/api/v1/media/<id>/info/, needs you to be logged in).
(() => {
  const MG = globalThis.MG;
  if (!MG || MG.site) return;
  MG.site = 'instagram';

  const cache = new Map(); // shortcode or pk -> media object
  const isMedia = (o) => (typeof o.code === 'string' || o.pk) && (o.video_versions || o.image_versions2 || o.carousel_media);

  MG.onJson = (json) => MG.walk(json, (o) => {
    if (!isMedia(o)) return;
    if (typeof o.code === 'string') cache.set(o.code, o);
    if (o.pk) cache.set(String(o.pk), o);
  });
  const rescan = MG.scanScripts('script[type="application/json"]', /video_versions|image_versions2/);

  const codeFromUrl = (u) => (String(u || '').match(/\/(?:p|reels?|tv)\/([\w-]{5,})/) || [])[1] || null;
  const storyFromUrl = (u) => (String(u || '').match(/\/stories\/[^/]+\/(\d+)/) || [])[1] || null;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const codeToPk = (code) => {
    let n = 0n;
    for (const c of code.slice(0, 11)) n = n * 64n + BigInt(ALPHABET.indexOf(c));
    return n.toString();
  };

  async function apiInfo(pk) {
    const r = await fetch(`/api/v1/media/${pk}/info/`, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Instagram refused the request. Are you logged in?' : `Instagram API HTTP ${r.status}`);
    const m = (await r.json()).items?.[0];
    if (!m) throw new Error('Post not found');
    return m;
  }

  const parts = (m) => (m.carousel_media?.length ? m.carousel_media : [m]);
  // A cached object without a DASH manifest may be missing the top-quality stream; ask the API.
  const wantsApi = (m) => parts(m).some((c) => c.video_versions?.length && !c.video_dash_manifest);

  async function getMedia(ref) {
    const hit = (ref.code && cache.get(ref.code)) || (ref.pk && cache.get(ref.pk));
    if (hit && !wantsApi(hit)) return hit;
    try {
      return await apiInfo(ref.pk || codeToPk(ref.code));
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  }

  const biggest = (arr) => [...(arr || [])].sort((a, b) => b.width * b.height - a.width * a.height)[0];

  function toResult(m, postId) {
    const author = m.user?.username || m.owner?.username || '';
    const list = parts(m);
    const items = list.map((c, i) => {
      const thumb = [...(c.image_versions2?.candidates || [])].sort((a, b) => a.width - b.width)[0]?.url || '';
      const postUrl = m.code ? `https://www.instagram.com/p/${m.code}/` : location.href;
      const base = { site: 'instagram', postId, author, desc: m.caption?.text, index: i, count: list.length, thumb, postUrl };
      if (c.video_versions?.length) {
        const p = biggest(c.video_versions);
        const source = {
          type: 'ig',
          xml: c.video_dash_manifest || null,
          versions: c.video_versions.map((v) => ({ url: v.url, w: v.width || 0, h: v.height || 0 })),
          hasAudio: c.has_audio !== false,
        };
        return MG.item({ ...base, kind: 'video', label: c.video_dash_manifest ? 'best quality' : p.height ? `${p.height}p` : '', source });
      }
      const img = biggest(c.image_versions2?.candidates);
      if (!img) return null;
      return MG.item({ ...base, kind: 'image', label: `${img.width}×${img.height}`, source: { type: 'url', urls: [img.url], ext: 'jpg' } });
    }).filter(Boolean);
    return { postId, author: author ? `@${author}` : '', title: (m.caption?.text || '').slice(0, 140), items };
  }

  const resolve = (ref) => getMedia(ref).then(
    (m) => toResult(m, m.code || ref.code || ref.pk),
    (e) => ({ postId: ref.code || ref.pk, items: [], error: e.message }),
  );

  const refFromArticle = (art) => {
    const a = art?.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    const code = codeFromUrl(a?.getAttribute('href'));
    return code ? { code } : null;
  };
  const refFromLocation = () => {
    const code = codeFromUrl(location.pathname);
    if (code) return { code };
    const pk = storyFromUrl(location.pathname);
    return pk ? { pk } : null;
  };

  MG.list = async () => {
    rescan();
    const here = refFromLocation();
    const refs = here ? [here] : MG.visible([...document.querySelectorAll('article')]).map(refFromArticle).filter(Boolean);
    const out = await Promise.all(MG.uniqueBy(refs, (r) => r.code || r.pk).map(resolve));
    return here ? out : out.filter((p) => p.items.length);
  };

  MG.context = async ({ linkUrl }) => {
    const code = codeFromUrl(linkUrl);
    const ref = (code && { code }) || refFromArticle(MG.contextPath().find((el) => el.tagName === 'ARTICLE')) || refFromLocation();
    if (!ref) throw new Error('Could not find an Instagram post here');
    return [await resolve(ref)];
  };
})();
