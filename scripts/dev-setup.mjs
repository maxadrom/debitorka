#!/usr/bin/env node
'use strict';

// scripts/dev-setup.mjs
// Читает .env из корня репозитория и генерирует dev-config.local.js,
// чтобы локальный браузерный dev-режим знал, куда стучаться webhook'ом.
//
// Запуск: node scripts/dev-setup.mjs (или npm run dev:setup).
// Файл dev-config.local.js гитигнорится и не попадает в ZIP (см. pack.mjs).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const OUT_PATH = resolve(ROOT, 'dev-config.local.js');

console.log('[dev-setup] start');

if (!existsSync(ENV_PATH)) {
  console.error('[dev-setup] .env not found at', ENV_PATH);
  console.error('[dev-setup] copy .env.example to .env and fill B24_WEBHOOK_URL first');
  process.exit(1);
}

const env = readFileSync(ENV_PATH, 'utf8');
const match = env.match(/^\s*B24_WEBHOOK_URL\s*=\s*(.+?)\s*$/m);
if (!match) {
  console.error('[dev-setup] B24_WEBHOOK_URL not found in .env');
  process.exit(1);
}

const webhook = match[1].trim().replace(/^['"]|['"]$/g, '');
if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(webhook)) {
  console.error('[dev-setup] B24_WEBHOOK_URL has unexpected format (expected https://<portal>/rest/<id>/<token>/)');
  process.exit(1);
}

const banner = [
  '// DEV-ONLY. Сгенерирован scripts/dev-setup.mjs из .env.',
  '// НЕ КОММИТИТЬ (см. .gitignore). НЕ ПОПАДАЕТ в ZIP-артефакт (см. pack.mjs).',
  `window.B24_WEBHOOK_URL = ${JSON.stringify(webhook)};`,
  '',
].join('\n');

writeFileSync(OUT_PATH, banner, 'utf8');
console.log('[dev-setup] wrote', OUT_PATH, '(hasWebhookConfig=true)');
