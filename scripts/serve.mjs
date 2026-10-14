#!/usr/bin/env node
'use strict';

// scripts/serve.mjs — локальный статический сервер для dev-режима, без кеша и без зависимостей.
// Нужен только Node (Python не нужен). Отдаёт файлы из корня проекта на 127.0.0.1.
//
//   npm run serve                 # http://localhost:8081/index.html
//   PORT=8090 npm run serve       # другой порт
//
// Cache-Control: no-store — после правок браузер всегда берёт свежие ES-модули (без hard reload).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8081;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = resolve(ROOT, `.${rel}`);
    // Не выпускаем за пределы проекта и не отдаём секреты.
    if (!file.startsWith(ROOT + sep) || /(^|[/\\])\.env/.test(rel)) return send(403, 'Forbidden');
    if (!(await stat(file)).isFile()) return send(404, 'Not found');
    send(200, await readFile(file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(404, 'Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[serve] порт ${PORT} занят другим процессом. Чужой процесс не останавливай — `
      + `запусти на другом порту: PORT=${PORT + 1} npm run serve`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://localhost:${PORT}/index.html (Ctrl+C — остановить)`);
});
