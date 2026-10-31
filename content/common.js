// Shared content-script plumbing. Each site script sets MG.list / MG.context / MG.onJson.
(() => {
  if (globalThis.MG) return;
  const MG = (globalThis.MG = { site: null });

  // Remember what was right-clicked so the context menu can find the post.
  let ctxPath = [];
  let ctxTime = 0;
  document.addEventListener('contextmenu', (e) => {
    ctxPath = e.composedPath().filter((n) => n instanceof Element);
    ctxTime = Date.now();
  }, true);
  MG.contextPath = () => (Date.now() - ctxTime < 120000 ? ctxPath : []);

  // JSON captured by inject/hook.js in the page world.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__mg !== 'json') return;
    try { MG.onJson?.(e.data.json, e.data.url); } catch (err) { console.debug('[MediaGrab]', err); }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.to !== 'content') return;
    const fn = msg.type === 'MG_LIST' ? MG.list : msg.type === 'MG_CONTEXT' ? MG.context : null;
    if (!fn) return;
    (async () => fn(msg))().then(
      (posts) => sendResponse({ ok: true, posts: (posts || []).filter(Boolean) }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  });

  // Iterative walk over a JSON tree, calling visit() on every non-array object.
  MG.walk = (root, visit, maxNodes = 300000) => {
    const stack = [root];
    const seen = new Set();
    let n = 0;
    while (stack.length && n++ < maxNodes) {
      const o = stack.pop();
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      if (!Array.isArray(o)) visit(o);
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  };

  // Parse embedded JSON <script> blobs once the DOM is ready.
  MG.scanScripts = (selector, test) => {
    const run = () => {
      for (const s of document.querySelectorAll(selector)) {
        const t = s.textContent;
        if (!t || (test && !test.test(t))) continue;
        try { MG.onJson?.(JSON.parse(t)); } catch {}
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
    return run;
  };

  // Elements on screen, most visible first.
  MG.visible = (els, max = 6) => els
    .map((el) => {
      const r = el.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      return { el, a: h * w };
    })
    .filter((x) => x.a > 0)
    .sort((a, b) => b.a - a.a)
    .slice(0, max)
    .map((x) => x.el);

  MG.sanitize = (s) => String(s || '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'x';

  // Keep only characters Chrome/Windows/macOS accept in a filename (drops links too).
  MG.fileSafe = (s) => String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[<>:"/\\|?*~\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const trimEnds = (s) => s.trim().replace(/[.\s]+$/, '');

  // "<handle> - <first 30 chars of description>[_n]"
  MG.filename = (p) => {
    const handle = trimEnds(MG.fileSafe(p.handle ?? p.author)) || p.site;
    const desc = trimEnds(Array.from(MG.fileSafe(p.desc)).slice(0, 30).join('')) || MG.fileSafe(p.postId);
    return `${handle} - ${desc}${p.count > 1 ? `_${p.index + 1}` : ''}`;
  };

  MG.item = (p) => ({
    key: `${p.site}:${p.postId}:${p.index}`,
    site: p.site,
    postId: p.postId,
    kind: p.kind,
    label: p.label || '',
    thumb: p.thumb || '',
    index: p.index,
    count: p.count,
    filename: MG.filename(p),
    url: p.postUrl || location.href, // post page, for yt-dlp fallback / MP3
    // Raw parts so the service worker can apply the user's filename settings.
    name: { site: p.site, handle: p.handle ?? p.author ?? '', handleKind: p.handleKind || 'user', desc: p.desc || '', postId: p.postId, index: p.index, count: p.count },
    source: p.source,
  });

  // Cross-origin JSON via the service worker (it has host permissions, no CORS).
  MG.bgFetchJson = async (url, headers) => {
    const r = await chrome.runtime.sendMessage({ to: 'sw', type: 'MG_FETCH_JSON', url, headers });
    if (!r?.ok) throw new Error(r?.error || 'fetch failed');
    return r.data;
  };

  MG.uniqueBy = (arr, keyFn) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = keyFn(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
})();
