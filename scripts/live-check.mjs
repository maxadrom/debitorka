#!/usr/bin/env node
'use strict';

// scripts/live-check.mjs
// Живая сверка отчёта с порталом: тот же loadReport, что в браузере, но из Node через
// вебхук из .env. Только чтение. Сам вебхук не печатается.
//
//   npm run check:live                                   # текущий месяц
//   npm run check:live -- 2026-10-01 2026-10-31          # период по сроку оплаты
//   npm run check:live -- 2026-10-01 2026-10-31 '{"assignedById":[19]}'  # + любые фильтры
//
// Печатает «Итого», % сбора, число клиентов и сотрудников. Цифры сверки записывай
// в docs/research.md (без реальных ФИО — только итоги).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBitrixQuery, parseBatchResponse } from '../modules/infrastructure/api-client.js';
import { loadReport } from '../modules/application/data-loader.js';
import { collectionRate } from '../modules/application/aggregator.js';
import { defaultFilters } from '../modules/application/filters.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const match = readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^B24_WEBHOOK_URL=(\S+)/m);
if (!match) {
  console.error('[live-check] B24_WEBHOOK_URL не задан в .env');
  process.exit(1);
}
const WEBHOOK = match[1].endsWith('/') ? match[1] : `${match[1]}/`;

let requests = 0;
async function post(method, body) {
  requests += 1;
  for (let attempt = 1; ; attempt += 1) {
    const r = await fetch(WEBHOOK + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error === 'QUERY_LIMIT_EXCEEDED' && attempt < 4) {
      await new Promise((res) => setTimeout(res, 1000 * attempt));
      continue;
    }
    if (json.error) throw new Error(`${method}: ${json.error_description || json.error}`);
    return json;
  }
}

// Тот же контракт, что у api-client.js в dev-режиме.
const apiClient = {
  async callMethod(method, params) {
    const json = await post(method, params);
    return { result: json.result, total: json.total };
  },
  async callBatch(commands) {
    const cmd = commands.map(([method, params]) => `${method}?${toBitrixQuery(params)}`);
    return parseBatchResponse(await post('batch', { halt: 1, cmd }), commands.length);
  },
};

const [from, to, extra] = process.argv.slice(2);
const filters = {
  ...defaultFilters(),
  ...(from ? { closedateFrom: from } : {}),
  ...(to ? { closedateTo: to } : {}),
  ...(extra ? JSON.parse(extra) : {}),
};

const t0 = Date.now();
const report = await loadReport(filters, apiClient);
const t = report.totals;
const rate = collectionRate(t);
const money = (n) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

console.log(`Фильтры:          ${JSON.stringify(filters)}`);
console.log(`Должен всего:     ${money(t.amount)}`);
console.log(`Оплачено:         ${money(t.paid)}`);
console.log(`Остаток к оплате: ${money(t.remain)}`);
console.log(`Просрочено:       ${money(t.overdue)}`);
console.log(`% сбора:          ${rate === null ? '—' : `${(rate * 100).toFixed(1)} %`}`);
console.log(`Клиентов: ${report.byContact.size}, сотрудников: ${report.byAssignee.size}`);
console.log(`REST-запросов: ${requests}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
