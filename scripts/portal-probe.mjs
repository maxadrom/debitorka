#!/usr/bin/env node
'use strict';

// scripts/portal-probe.mjs
// Разведка портала для адаптации отчёта: находит значения для portal-config.js и проверяет
// текущие. Только чтение, вебхук из .env, сам вебхук не печатается.
//
//   npm run portal:probe
//
// Что делает:
//   1. Права вебхука (метод scope) — нужны crm и user.
//   2. Воронки счетов и их стадии: «Оплачен» (SEMANTICS = S), «Не оплачен» (SEMANTICS = F).
//   3. Поля счёта типа date/datetime с «оплат» в названии — кандидаты на «Дату оплаты»,
//      и заполненность текущего PAY_DATE_FIELD у оплаченных счетов.
//   4. Наши ЮЛ (IS_MY_COMPANY = Y) — если их больше одного, см. рецепт в docs/adapt-to-portal.md.
//   5. Итог: ✅/❌ по каждому значению PORTAL и вопросы, которые надо задать человеку.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTAL } from '../modules/application/portal-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let envText = '';
try { envText = readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch { /* нет .env */ }
const match = envText.match(/^B24_WEBHOOK_URL=(\S+)/m);
if (!match) {
  console.error('❌ B24_WEBHOOK_URL не задан в .env — см. docs/adapt-to-portal.md, шаг «Вебхук».');
  process.exit(1);
}
const WEBHOOK = match[1].endsWith('/') ? match[1] : `${match[1]}/`;

async function call(method, params = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const r = await fetch(WEBHOOK + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
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

const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg) => console.log(`  ❌ ${msg}`);
const info = (msg) => console.log(`  • ${msg}`);
const questions = [];
const suggested = {};

// 1. Права
console.log('\n1. Права вебхука');
const scopes = (await call('scope')).result || [];
for (const need of ['crm', 'user']) {
  if (scopes.includes(need)) ok(`есть «${need}»`);
  else bad(`нет «${need}» — добавьте право в настройках входящего вебхука`);
}

// 2. Воронки и стадии
console.log('\n2. Воронки и стадии счетов (entityTypeId = 31)');
const categories = (await call('crm.category.list', { entityTypeId: PORTAL.ENTITY_TYPE_INVOICE })).result?.categories || [];
const stages = [];
for (const cat of categories) {
  const list = (await call('crm.status.list', { filter: { ENTITY_ID: `SMART_INVOICE_STAGE_${cat.id}` } })).result || [];
  const total = (await call('crm.item.list', {
    entityTypeId: PORTAL.ENTITY_TYPE_INVOICE, filter: { categoryId: cat.id }, select: ['id'],
  })).total;
  info(`воронка ${cat.id} «${cat.name}»: счетов ${total}`);
  for (const s of list) {
    const mark = s.SEMANTICS === 'S' ? '  ← «Оплачен» (S)' : s.SEMANTICS === 'F' ? '  ← «Не оплачен» (F)' : '';
    console.log(`      ${s.STATUS_ID.padEnd(22)} ${s.NAME}${mark}`);
    stages.push(s);
  }
}
if (categories.length > 1) {
  questions.push(`У счетов ${categories.length} воронки. Какие из них считать в отчёте? (код поддерживает одну стадию «Оплачен» — нужна доработка)`);
}
const success = stages.filter((s) => s.SEMANTICS === 'S');
const failure = stages.filter((s) => s.SEMANTICS === 'F');
if (success.length === 1) suggested.STAGE_PAID = success[0].STATUS_ID;
if (failure.length === 1) suggested.STAGE_FAILED = failure[0].STATUS_ID;

// 3. Дата оплаты
console.log('\n3. Поле «Дата оплаты»');
const fields = (await call('crm.item.fields', { entityTypeId: PORTAL.ENTITY_TYPE_INVOICE })).result?.fields || {};
const candidates = Object.entries(fields)
  .filter(([, f]) => (f.type === 'date' || f.type === 'datetime') && /оплат/i.test(f.title || ''));
for (const [name, f] of candidates) info(`${name} (${f.type}) — «${f.title}»`);
if (candidates.length === 0) info('полей date/datetime с «оплат» в названии нет');

async function fillRate(field) {
  const r = await call('crm.item.list', {
    entityTypeId: PORTAL.ENTITY_TYPE_INVOICE,
    filter: { stageId: suggested.STAGE_PAID || PORTAL.STAGE_PAID },
    select: ['id', field],
    order: { id: 'DESC' },
  });
  const items = r.result?.items || [];
  return { filled: items.filter((i) => i[field]).length, sample: items.length };
}
const payCandidates = candidates.filter(([name]) => name !== 'closedate');
for (const [name] of payCandidates) {
  const { filled, sample } = await fillRate(name);
  info(`${name}: заполнено у ${filled} из ${sample} последних оплаченных счетов`);
  if (filled > 0 && !suggested.PAY_DATE_FIELD) suggested.PAY_DATE_FIELD = name;
}
if (!suggested.PAY_DATE_FIELD) {
  questions.push('Поля «Дата оплаты» нет или оно пустое у оплаченных счетов. Что считать датой оплаты? '
    + 'Варианты — docs/adapt-to-portal.md, «Рекомендации: если поля даты оплаты нет».');
}

// 4. Наши ЮЛ
console.log('\n4. Наши ЮЛ (IS_MY_COMPANY = Y)');
const my = await call('crm.company.list', { filter: { IS_MY_COMPANY: 'Y' }, select: ['ID'] });
info(`компаний: ${my.total}`);
if (my.total > 1) {
  questions.push(`Наших ЮЛ ${my.total}. Нужен фильтр «Наше ЮЛ» (поле счёта mycompanyId)? `
    + 'Рецепт — docs/adapt-to-portal.md, «Рекомендации: фильтр „Наше ЮЛ“».');
}

// 5. Проверка portal-config.js
console.log('\n5. Проверка modules/application/portal-config.js');
const byId = new Map(stages.map((s) => [s.STATUS_ID, s]));
const checkStage = (key, semantics) => {
  const s = byId.get(PORTAL[key]);
  if (s && s.SEMANTICS === semantics) ok(`${key} = '${PORTAL[key]}' («${s.NAME}», SEMANTICS ${semantics})`);
  else bad(`${key} = '${PORTAL[key]}' — ${s ? `SEMANTICS ${s.SEMANTICS}, а нужно ${semantics}` : 'такой стадии нет'}`
    + (suggested[key] ? `; предлагается '${suggested[key]}'` : ''));
};
checkStage('STAGE_PAID', 'S');
checkStage('STAGE_FAILED', 'F');
const payField = fields[PORTAL.PAY_DATE_FIELD];
if (payField && (payField.type === 'date' || payField.type === 'datetime')) {
  const { filled, sample } = await fillRate(PORTAL.PAY_DATE_FIELD);
  if (filled > 0) ok(`PAY_DATE_FIELD = '${PORTAL.PAY_DATE_FIELD}' («${payField.title}», заполнено ${filled}/${sample})`);
  else bad(`PAY_DATE_FIELD = '${PORTAL.PAY_DATE_FIELD}' есть, но пусто у последних оплаченных счетов`);
} else {
  bad(`PAY_DATE_FIELD = '${PORTAL.PAY_DATE_FIELD}' — такого поля date/datetime у счетов нет`
    + (suggested.PAY_DATE_FIELD ? `; предлагается '${suggested.PAY_DATE_FIELD}'` : ''));
}

if (questions.length) {
  console.log('\n❓ Спросить человека, прежде чем менять код:');
  questions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
} else {
  console.log('\nВопросов к человеку нет.');
}
console.log('\nНапоминание: после работ удалите входящий вебхук на портале (docs/adapt-to-portal.md, шаг 8).\n');
