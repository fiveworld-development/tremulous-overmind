// Cloudflare Worker on webnova360.com/play-tremulous* (the main site is a Pages project).
// Forwards the path unchanged to the game origin, websockets included. Until the origin
// answers as Tremulous Overmind (X-Overmind header), visitors get a holding page instead
// of whatever else the host serves.
const ORIGIN = 'https://play.webnova360.com';
const PREFIX = '/play-tremulous';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PREFIX) {
      return Response.redirect(url.origin + PREFIX + '/' + url.search, 301);
    }
    if (!url.pathname.startsWith(PREFIX + '/')) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const upstream = new Request(ORIGIN + url.pathname + url.search, request);
    // Subrequests from a Worker reach the origin with the Worker's own address in
    // CF-Connecting-IP, so every player would share one per-IP limit. Pass the real
    // client on (always overwritten here, so a visitor cannot set it). Every customer's
    // Workers share that egress range, so the origin trusts the header only together
    // with our secret (Worker secret ORIGIN_SECRET, also on the host, never in the repo).
    upstream.headers.set('X-Overmind-Client', request.headers.get('CF-Connecting-IP') || '');
    upstream.headers.set('X-Overmind-Auth', (env && env.ORIGIN_SECRET) || '');
    // the main site's cookies and credentials are none of the game server's business
    upstream.headers.delete('Cookie');
    upstream.headers.delete('Authorization');
    if (request.headers.get('Upgrade') === 'websocket') {
      return fetch(upstream);
    }

    let res;
    try {
      res = await fetch(upstream, { redirect: 'manual' });
    } catch (e) {
      res = null;
    }
    if (res && res.headers.get('X-Overmind') === '1') return res;
    return holding(url.pathname === PREFIX + '/' ? 503 : 404);
  },
};

function holding(status) {
  return new Response(PAGE, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '600',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tremulous – Browser Edition by WebNova360</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #c8d2c8; }
  body { display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         font: 16px/1.5 Bahnschrift, "Arial Narrow", system-ui, sans-serif; }
  main { max-width: 34rem; border: 1px solid #1f5a27; padding: 2rem 1.5rem; }
  h1 { margin: 0 0 .25rem; color: #3fb34f; letter-spacing: .3em; font-size: clamp(1.6rem, 6vw, 2.6rem); }
  p { margin: .75rem 0 0; }
  small { display: block; margin-top: 1.5rem; color: #7a867a; letter-spacing: .08em; text-transform: uppercase; }
  a { color: #2598ff; }
</style>
</head>
<body>
<main>
  <h1>TREMULOUS</h1>
  <p>The Overmind is still growing. The browser servers come online shortly – check back in a few minutes.</p>
  <small>Presented by <a href="https://webnova360.com/">WebNova360.com</a></small>
</main>
</body>
</html>`;
