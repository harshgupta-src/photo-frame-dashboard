// The frame-data Worker on Cloudflare while the real one runs on the Azure VM (worker/vm/README.md).
// Every client (frames, iPhone app, Home Assistant, Shortcuts, Copilot pushers) keeps using
// frame-data.<account>.workers.dev; this streams each request through to ORIGIN unchanged and the
// response back. It does no parsing, so it stays far under the free plan's 10 ms CPU limit.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ORIGIN) return new Response('frame-data proxy is not configured (ORIGIN is unset)', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const target = env.ORIGIN.replace(/\/$/, '') + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch (e) {
      return new Response(`frame-data origin unreachable: ${e.message}`, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
