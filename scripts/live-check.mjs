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
// Период — месяц, максимум квартал (≤ 92 дней). Больший период — только с флагом --long и
// только если человек сам попросил: квота REST ~2 запроса/с, год грузится минуту и дольше.
//
// Печатает «Итого», % сбора, число клиентов и сотрудников и делает НЕЗАВИСИМУЮ сверку
// без лишних запросов: число загруженных счетов = total из REST, без дублей, и «Итого»,
// пересчитанное простой формулой по сырым счетам, = «Итого» отчёта (aggregator.js).
// Свои скрипты сверки писать не нужно. Цифры записывай в docs/research.md (только итоги).
//
// В конце — блок «Для проверки в браузере»: те же цифры в формате интерфейса. Если сам
// открыть браузер не можешь — передай этот блок человеку вместе с чек-листом шага 6.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBitrixQuery, parseBatchResponse } from '../modules/infrastructure/api-client.js';
import { loadReport } from '../modules/application/data-loader.js';
import { collectionRate } from '../modules/application/aggregator.js';
import { defaultFilters, toDateKey } from '../modules/application/filters.js';
import { PORTAL } from '../modules/application/portal-config.js';
import { formatMoney } from '../modules/presentation/ui-helpers.js';

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

// Тот же контракт, что у api-client.js в dev-режиме. Попутно запоминаем сырые счета
// и total из crm.item.list — для независимой сверки без дополнительных запросов.
const raw = { invoices: [], total: null, single: 0, batches: 0 };
const pickInvoices = (method, result) => {
  if (method === 'crm.item.list' && Array.isArray(result?.items)) raw.invoices.push(...result.items);
};
const apiClient = {
  async callMethod(method, params) {
    const json = await post(method, params);
    if (method === 'crm.item.list') {
      raw.total = json.total;
      raw.single += 1;
    }
    pickInvoices(method, json.result);
    return { result: json.result, total: json.total };
  },
  async callBatch(commands) {
    const cmd = commands.map(([method, params]) => `${method}?${toBitrixQuery(params)}`);
    const out = parseBatchResponse(await post('batch', { halt: 1, cmd }), commands.length);
    if (commands[0]?.[0] === 'crm.item.list') raw.batches += 1;
    commands.forEach(([method], i) => pickInvoices(method, out[i].result));
    return out;
  },
};

const args = process.argv.slice(2);
const allowLong = args.includes('--long');
const [from, to, extra] = args.filter((a) => a !== '--long');
const filters = {
  ...defaultFilters(),
  ...(from ? { closedateFrom: from } : {}),
  ...(to ? { closedateTo: to } : {}),
  ...(extra ? JSON.parse(extra) : {}),
};

const MAX_DAYS = 92;
const days = (Date.parse(filters.closedateTo) - Date.parse(filters.closedateFrom)) / 86_400_000 + 1;
if (days > MAX_DAYS && !allowLong) {
  console.error(`[live-check] период ${days} дн. — больше квартала. Проверяй месяцем (или кварталом):`
    + ' это быстро и достаточно. Длинный период — только если человек сам попросил: добавь --long.');
  process.exit(1);
}

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
console.log(`REST-запросов: ${requests}, ${((Date.now() - t0) / 1000).toFixed(1)} с `
  + `(счета: ${raw.single} одиночный + ${raw.batches} batch по ≤ 50 страниц)`);

// ---- Независимая сверка (по тем же сырым счетам, без кода data-loader/aggregator) ----
console.log('\nНезависимая сверка:');
// С доп. фильтрами пересчёт «Итого» не делается — проверяй разрезы: сумма «Итого» по всем
// значениям фильтра (например, по каждому «Нашему ЮЛ») = «Итого» без фильтра.
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); return cond; };
const ids = new Set(raw.invoices.map((i) => i.id));
let allOk = ok(raw.invoices.length === raw.total, `загружено счетов ${raw.invoices.length}, total из REST ${raw.total}`);
allOk = ok(ids.size === raw.invoices.length, `без дублей: уникальных id ${ids.size}`) && allOk;

const hasExtra = (filters.assignedById?.length || 0) > 0 || filters.datePayFrom || filters.datePayTo
  || Object.keys(filters).some((k) => Array.isArray(filters[k]) && filters[k].length > 0);
if (hasExtra) {
  console.log('  • пересчёт «Итого» — только без доп. фильтров (ответственный, дата оплаты и т. п.)');
} else {
  const today = toDateKey(new Date());
  const naive = { amount: 0, paid: 0, overdue: 0 };
  for (const inv of raw.invoices) {
    if (inv.contactId == null) continue; // как в отчёте: счета без контакта не входят
    const opp = Number(inv.opportunity) || 0;
    const paid = inv.stageId === PORTAL.STAGE_PAID;
    naive.amount += opp;
    if (paid) naive.paid += opp;
    else if (String(inv.closedate).slice(0, 10) < today) naive.overdue += opp;
  }
  const same = (a, b) => Math.abs(a - b) < 0.005;
  allOk = ok(same(naive.amount, t.amount), `Должен всего: пересчёт ${money(naive.amount)}`) && allOk;
  allOk = ok(same(naive.paid, t.paid), `Оплачено: пересчёт ${money(naive.paid)}`) && allOk;
  allOk = ok(same(naive.overdue, t.overdue), `Просрочено: пересчёт ${money(naive.overdue)}`) && allOk;
}
// ---- Блок для человека: что он должен увидеть в браузере ----
const ddmmyyyy = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const extraFilters = Object.entries(filters)
  .filter(([k, v]) => !k.startsWith('closedate') && (Array.isArray(v) ? v.length > 0 : v))
  .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
console.log(`
Для проверки в браузере (npm run serve → http://localhost:8081/index.html):
  Срок оплаты: с ${ddmmyyyy(filters.closedateFrom)} по ${ddmmyyyy(filters.closedateTo)}; `
  + `${extraFilters.length ? `фильтры: ${extraFilters.join(', ')}` : 'остальные фильтры сброшены'}
  Итого · Должен всего:     ${formatMoney(t.amount)}
  Итого · Оплачено:         ${formatMoney(t.paid)}
  Итого · Просрочено:       ${formatMoney(t.overdue)}
  Итого · Остаток к оплате: ${formatMoney(t.remain)}
  % сбора дебиторки:        ${rate === null ? '—' : percent.format(rate)}
  Строк: по клиентам ${report.byContact.size}, по сотрудникам ${report.byAssignee.size}`);

if (!allOk) {
  console.log('\n❌ Расхождение. Не меняй код наугад: покажи вывод человеку и разберитесь вместе.');
  process.exitCode = 1;
}
