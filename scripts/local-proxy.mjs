/**
 * Local dev proxy — bridges Miniflare → NestJS backend.
 * Miniflare cannot resolve underscore hostnames via OS DNS.
 * This proxy runs as real Node.js (which CAN resolve them) and forwards all traffic.
 *
 * Usage: node scripts/local-proxy.mjs
 * Listens on http://localhost:8789 and forwards to NEST_TARGET over HTTPS.
 */

import http from 'http';
import https from 'https';

const PROXY_PORT = 8789;
const NEST_TARGET = 'https://trydos_wallet_develop.ramaaz.dev';
const target = new URL(NEST_TARGET);

const server = http.createServer((req, res) => {
  const options = {
    hostname: target.hostname,
    port: target.port || 443,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: target.hostname,
    },
    rejectUnauthorized: false, // allow self-signed / wildcard mismatch on dev backend
  };

  const proxy = https.request(options, (backendRes) => {
    res.writeHead(backendRes.statusCode, backendRes.headers);
    backendRes.pipe(res, { end: true });
  });

  proxy.on('error', (err) => {
    console.error('[proxy] backend error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'proxy error', detail: err.message }));
    }
  });

  req.pipe(proxy, { end: true });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[proxy] Listening on http://localhost:${PROXY_PORT} → ${NEST_TARGET}`);
});
