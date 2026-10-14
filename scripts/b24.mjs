#!/usr/bin/env node
'use strict';

// scripts/b24.mjs — один REST-запрос к порталу через вебхук из .env (для исследования полей).
// Всегда POST JSON: GET и form-urlencoded молча игнорируют операторы фильтра (>=, !=, @).
// Вебхук не печатается.
//
//   npm run b24 -- crm.category.list '{"entityTypeId":31}'
//   npm run b24 -- crm.status.list '{"filter":{"ENTITY_ID":"SMART_INVOICE_STAGE_2"}}'
//   npm run b24 -- crm.item.list '{"entityTypeId":31,"filter":{">=closedate":"2026-10-01"},"select":["id"]}'

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const match = readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^B24_WEBHOOK_URL=(\S+)/m);
if (!match) {
  console.error('[b24] B24_WEBHOOK_URL не задан в .env');
  process.exit(1);
}
const [method, params = '{}'] = process.argv.slice(2);
if (!method) {
  console.error('Использование: npm run b24 -- <метод> \'<JSON-параметры>\'');
  process.exit(1);
}
const webhook = match[1].endsWith('/') ? match[1] : `${match[1]}/`;
const r = await fetch(webhook + method, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: params,
});
const json = await r.json();
if (json.error) {
  console.error(`[b24] ${method}: ${json.error_description || json.error}`);
  process.exit(1);
}
if (json.total !== undefined) console.error(`[b24] total=${json.total}`);
console.log(JSON.stringify(json.result, null, 2));
