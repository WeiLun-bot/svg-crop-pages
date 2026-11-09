import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../server/github.mjs';

const port = Number(process.env.PORT || 8787);
const origin = 'http://127.0.0.1:' + port;
const env = { BACKEND_ORIGIN: origin, FRONTEND_URL: origin + '/', ...process.env };
const handle = createHandler();
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/github-upload.js', ['github-upload.js', 'text/javascript; charset=utf-8']],
  ['/github-upload.css', ['github-upload.css', 'text/css; charset=utf-8']],
  ['/github-config.json', ['github-config.json', 'application/json; charset=utf-8']],
]);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/github')) {
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: req, duplex: 'half' } : {}) });
      const response = await handle(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const file = files.get(url.pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    const bytes = await readFile(new URL('../' + file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(500); res.end('Local preview failed'); }
}).listen(port, '127.0.0.1', () => console.log('SVG crop studio: ' + origin));
