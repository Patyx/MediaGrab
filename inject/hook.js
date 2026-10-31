// Runs in the page's own JS world (MAIN) at document_start on X, Instagram and TikTok.
// Copies JSON API responses the site already fetches and hands them to the content
// script, which picks out media URLs. Nothing is modified; responses pass through untouched.
(() => {
  if (window.__mediagrabHook) return;
  window.__mediagrabHook = true;

  const WANT = /\/(graphql|api)\//i;
  // Only responses that can contain media are parsed and handed over (keeps pages snappy).
  const MEDIA = /video_versions|image_versions2|extended_entities|mediaDetails|playAddr|bitrateInfo|imagePost|playable_url|browser_native|representations|"Photo"|"Video"/;
  const want = (url) => typeof url === 'string' && WANT.test(url);

  const post = (url, json) => {
    try { window.postMessage({ __mg: 'json', url, json }, location.origin); } catch {}
  };
  const parseLoose = (text) => {
    if (!text || !MEDIA.test(text)) return [];
    const t = text.replace(/^for \(;;\);/, '').trim();
    if (t[0] !== '{' && t[0] !== '[') return [];
    try { return [JSON.parse(t)]; } catch {}
    // Some endpoints stream several JSON documents separated by newlines.
    const out = [];
    for (const line of t.split('\n')) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = res.url || (args[0] && (args[0].url || String(args[0])));
      if (want(url)) {
        res.clone().text().then((t) => parseLoose(t).forEach((j) => post(url, j))).catch(() => {});
      }
    } catch {}
    return res;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mgUrl = String(url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (want(this.__mgUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === 'json') { if (this.response && MEDIA.test(JSON.stringify(this.response))) post(this.__mgUrl, this.response); }
          else if (!this.responseType || this.responseType === 'text') parseLoose(this.responseText).forEach((j) => post(this.__mgUrl, j));
        } catch {}
      });
    }
    return send.apply(this, arguments);
  };
})();
