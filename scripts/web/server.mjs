import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  let path;
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid path');
    path = resolve(root, '.' + pathname);
  } catch {
    response.writeHead(400).end('Invalid URL');
    return;
  }
  if (path !== root && !path.startsWith(root + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (info?.isDirectory()) path = resolve(path, 'index.html');
    if (!info) {
      if (extname(path)) {
        response.writeHead(404).end('Not found');
        return;
      }
      path = resolve(root, 'index.html');
    }
    const content = await readFile(path);
    response.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') {
      response.writeHead(404).end('Not found');
      return;
    }
    console.error(error);
    response.writeHead(500).end('Could not read application files');
  }
});

server.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`FairShare listening on http://${host}:${port}`);
  console.log(`Open http://localhost:${port} on this computer. Press Ctrl+C to stop.`);
});
