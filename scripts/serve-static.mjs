// A small static file server that applies a Cloudflare `_headers` file, so pages run under the
// Content-Security-Policy they ship with. No dependencies.
//
// Usage: node scripts/serve-static.mjs <root> [--port <n>] [--spa | --404-page]
//   --spa       unknown page paths get index.html, like the app (wrangler.jsonc)
//   --404-page  unknown paths get 404.html with a 404, like the landing site (site/wrangler.jsonc)
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.dbc': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

/** Parses `_headers` into rules of a path pattern and its headers. Only `*` splats are supported. */
function parseHeadersFile(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ path: new RegExp(`^${pattern}$`), headers: {} });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0 && rules.length > 0) rules.at(-1).headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

function fileAt(root, path) {
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(root + sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/**
 * Serves `root` on 127.0.0.1. `notFound` is 'spa' or '404-page'. Resolves to the server and its
 * origin once it listens; port 0 picks a free port.
 */
export function startStaticServer({ root, port = 0, notFound = '404-page' }) {
  root = resolve(root);
  const headersFile = join(root, '_headers');
  const rules = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];

  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return res.writeHead(400).end();
    }
    const send = (status, file, extra = {}) => {
      const headers = { ...extra };
      for (const rule of rules) if (rule.path.test(path)) Object.assign(headers, rule.headers);
      if (file) {
        headers['Content-Type'] = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
        headers['Content-Length'] = statSync(file).size;
      }
      res.writeHead(status, headers);
      if (file && req.method !== 'HEAD') createReadStream(file).pipe(res);
      else res.end();
    };

    // Clean URLs, as Cloudflare's auto-trailing-slash: /page/ serves page/index.html, /page redirects.
    let file = path.endsWith('/') ? fileAt(root, `${path}index.html`) : fileAt(root, path);
    if (!file && !path.endsWith('/') && fileAt(root, `${path}/index.html`)) return send(307, null, { Location: `${path}/` });
    if (!file && !path.endsWith('/')) file = fileAt(root, `${path}.html`);
    if (file && path !== '/_headers') return send(200, file);

    // Cloudflare's SPA fallback answers every missing path with the page; only navigations get it
    // here, so a missing script or asset shows up as a failed request.
    if (notFound === 'spa' && req.headers['sec-fetch-mode'] === 'navigate') return send(200, join(root, 'index.html'));
    const page = notFound === '404-page' && fileAt(root, '/404.html');
    return send(404, page || null);
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const root = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
  if (!root) {
    console.error('usage: node scripts/serve-static.mjs <root> [--port <n>] [--spa | --404-page]');
    process.exit(1);
  }
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8000;
  const { origin } = await startStaticServer({ root, port, notFound: args.includes('--spa') ? 'spa' : '404-page' });
  console.log(`Serving ${root} at ${origin}/`);
}
