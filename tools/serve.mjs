import http from 'node:http';
import https from 'node:https';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const options = { host: '127.0.0.1', port: '8080' };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!['host', 'port', 'cert', 'key'].includes(key) || !args[i + 1]) throw new Error('Usage: node tools/serve.mjs [--host 127.0.0.1] [--port 8080] [--cert file --key file]');
  options[key] = args[i + 1];
}
if (Boolean(options.cert) !== Boolean(options.key)) throw new Error('Для HTTPS нужны и --cert, и --key.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
async function handler(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden path');
    let file = await realpath(resolve(root, `.${path}`));
    if (file !== root && !file.startsWith(root + sep)) throw new Error('Outside root');
    if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
    if (!file.startsWith(root + sep)) throw new Error('Outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}
const server = options.cert ? https.createServer({ cert: await readFile(options.cert), key: await readFile(options.key) }, handler) : http.createServer(handler);
server.listen(Number(options.port), options.host, () => console.log(`RadioBridge: ${options.cert ? 'HTTPS' : 'HTTP'} ${options.host}:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
