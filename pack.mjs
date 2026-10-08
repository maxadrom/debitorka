#!/usr/bin/env node
'use strict';

// pack.mjs — упаковка локального приложения в dist/fin25_otch.zip.
//
// Whitelist (в архиве): index.html, app.js, styles.css, modules/**/*.js,
//   vendor/**, manifest/**.
// Blacklist: .env*, dev-config*, tests/**, scripts/**, plans/**, .claude/**,
//   node_modules/**, dist/**, *.md, package.json*, *.zip, *.log, .DS_Store, и т.п.
// Sanity-check: после сборки проверяем, что в архив не попало ничего из blacklist.
// Размер: ZIP должен быть ≤ 500 KB.

import { createWriteStream, mkdirSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = resolve(ROOT, 'dist');
const OUT_PATH = resolve(OUT_DIR, 'fin25_otch.zip');
const SIZE_LIMIT_KB = 500;

console.log('[pack] start');

// --- Whitelist (паттерны путей относительно корня) ---
const includes = [
  'index.html',
  'app.js',
  'styles.css',
];
const includeDirs = [
  { dir: 'modules', filter: (p) => p.endsWith('.js') },
  { dir: 'vendor', filter: () => true },
  { dir: 'manifest', filter: () => true },
];

// --- Blacklist ---
const FORBIDDEN_PATTERNS = [
  /^\.env(\..*)?$/,
  /^dev-config\.(local|example)\.js$/,
  /^tests(\/|$)/,
  /^scripts(\/|$)/,
  /^plans(\/|$)/,
  /^\.claude(\/|$)/,
  /^node_modules(\/|$)/,
  /^dist(\/|$)/,
  /^pack\.mjs$/,
  /^package(-lock)?\.json$/,
  /\.md$/i,
  /\.zip$/i,
  /\.log$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.gitkeep$/,
  /(^|\/)\.gitignore$/,
];

function isForbidden(rel) {
  return FORBIDDEN_PATTERNS.some((re) => re.test(rel));
}

function walk(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const ent of entries) {
      const abs = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        const rel = relative(ROOT, abs).split(sep).join('/');
        if (filter(rel) && !isForbidden(rel)) out.push(rel);
      }
    }
  }
  return out;
}

function collectFiles() {
  const files = new Set();
  for (const f of includes) {
    if (existsSync(resolve(ROOT, f)) && !isForbidden(f)) files.add(f);
  }
  for (const { dir, filter } of includeDirs) {
    for (const rel of walk(resolve(ROOT, dir), filter)) {
      files.add(rel);
    }
  }
  return Array.from(files).sort();
}

async function getArchiver() {
  try {
    const mod = await import('archiver');
    return mod.default || mod;
  } catch (err) {
    console.error('[pack] archiver dep is missing — run `npm install`');
    process.exit(1);
  }
}

async function main() {
  const files = collectFiles();
  if (files.length === 0) {
    console.error('[pack] no files matched whitelist — aborting');
    process.exit(1);
  }

  // Content sanity-check: ни в одном whitelist-файле не должно быть webhook-URL
  // (формат /rest/<id>/<token>/). Это defense-in-depth поверх blacklist'а
  // .env*/dev-config.* — на случай если токен случайно попал в app.js/modules/*.
  const WEBHOOK_RE = /https?:\/\/[^\s\/]+\/rest\/\d+\/[a-z0-9]+\/?/i;
  for (const f of files) {
    const abs = resolve(ROOT, f);
    let text;
    try { text = readFileSync(abs, 'utf8'); }
    catch { continue; } // бинарные файлы (vendor xlsx) пропускаем
    if (WEBHOOK_RE.test(text)) {
      console.error(`[pack] WEBHOOK URL leaked in ${f}`); // сам URL не печатаем — это секрет
      process.exit(1);
    }
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const archiver = await getArchiver();
  const archive = archiver('zip', { zlib: { level: 9 } });
  const out = createWriteStream(OUT_PATH);

  const archivedNames = [];
  archive.on('entry', (entry) => archivedNames.push(entry.name));
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') {
      console.error('[pack] warning', err);
      process.exit(1);
    }
  });
  archive.on('error', (err) => {
    console.error('[pack] error', err);
    process.exit(1);
  });
  archive.pipe(out);

  for (const rel of files) {
    archive.file(resolve(ROOT, rel), { name: rel });
  }

  await archive.finalize();
  await new Promise((res) => out.on('close', res));

  console.log(`[pack] included ${archivedNames.length} files`);

  // Sanity-check ПОСЛЕ сборки: проверяем имена записей в архиве.
  for (const name of archivedNames) {
    if (isForbidden(name)) {
      console.error(`[pack] FORBIDDEN entry leaked: ${name}`);
      process.exit(1);
    }
  }
  console.log('[pack] sanity-check passed');

  const sizeKB = Math.round(statSync(OUT_PATH).size / 1024);
  console.log(`[pack] size=${sizeKB}KB out=${relative(ROOT, OUT_PATH)}`);
  if (sizeKB > SIZE_LIMIT_KB) {
    console.error(`[pack] size limit exceeded: ${sizeKB}KB > ${SIZE_LIMIT_KB}KB`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[pack] failed', err);
  process.exit(1);
});
