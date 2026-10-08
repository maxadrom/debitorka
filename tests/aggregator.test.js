'use strict';

// tests/aggregator.test.js
// Юнит-тесты чистой функции aggregate() и totals(). Запуск: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, totals, STAGE_PAID } from '../modules/application/aggregator.js';

const STAGE_OVERDUE = 'DT31_5:S'; // активная стадия (любая ≠ STAGE_PAID и ≠ DT31_5:D)
const STAGE_NEW = 'DT31_5:UC_VQM7R0';

const today = new Date(2026, 3, 30); // 2026-04-30 (месяц 3 = апрель, локальная TZ)

test('1) пустой массив → пустая Map; totals = нули', () => {
  const result = aggregate([], today);
  assert.equal(result.size, 0);
  assert.deepEqual(totals(result), { amount: 0, paid: 0, overdue: 0, remain: 0 });
});

test('2) один счёт DT31_5:P (closedate в прошлом) → paid=opp, overdue=0, remain=0', () => {
  const inv = { id: 1, contactId: 100, opportunity: 1500, stageId: STAGE_PAID, closedate: '2026-04-01' };
  const result = aggregate([inv], today);
  const acc = result.get(100);
  assert.deepEqual(acc, { amount: 1500, paid: 1500, overdue: 0, remain: 0 });
});

test('3) счёт со stageId=DT31_5:S, closedate < today → overdue=opp, remain=opp, paid=0', () => {
  const inv = { id: 2, contactId: 100, opportunity: 700, stageId: STAGE_OVERDUE, closedate: '2026-04-01' };
  const result = aggregate([inv], today);
  assert.deepEqual(result.get(100), { amount: 700, paid: 0, overdue: 700, remain: 700 });
});

test('4) счёт со stageId=DT31_5:UC_*, closedate > today → remain=opp, overdue=0', () => {
  const inv = { id: 3, contactId: 100, opportunity: 200, stageId: STAGE_NEW, closedate: '2026-05-15' };
  const result = aggregate([inv], today);
  assert.deepEqual(result.get(100), { amount: 200, paid: 0, overdue: 0, remain: 200 });
});

test('5) несколько счетов на одном контакте — суммирование по amount/paid/overdue/remain', () => {
  const invs = [
    { id: 1, contactId: 100, opportunity: 1000, stageId: STAGE_PAID, closedate: '2026-04-10' },
    { id: 2, contactId: 100, opportunity: 500, stageId: STAGE_OVERDUE, closedate: '2026-04-05' },
    { id: 3, contactId: 100, opportunity: 250, stageId: STAGE_NEW, closedate: '2026-05-15' },
  ];
  const result = aggregate(invs, today);
  assert.deepEqual(result.get(100), { amount: 1750, paid: 1000, overdue: 500, remain: 750 });
  assert.deepEqual(totals(result), { amount: 1750, paid: 1000, overdue: 500, remain: 750 });
});

test('6) несколько контактов — отдельные ключи Map', () => {
  const invs = [
    { id: 1, contactId: 100, opportunity: 1000, stageId: STAGE_PAID, closedate: '2026-04-10' },
    { id: 2, contactId: 200, opportunity: 500, stageId: STAGE_OVERDUE, closedate: '2026-04-05' },
  ];
  const result = aggregate(invs, today);
  assert.equal(result.size, 2);
  assert.deepEqual(result.get(100), { amount: 1000, paid: 1000, overdue: 0, remain: 0 });
  assert.deepEqual(result.get(200), { amount: 500, paid: 0, overdue: 500, remain: 500 });
});

test('7) closedate === today → НЕ просрочен (строгое <)', () => {
  const inv = { id: 1, contactId: 100, opportunity: 100, stageId: STAGE_OVERDUE, closedate: '2026-04-30' };
  const result = aggregate([inv], today);
  assert.deepEqual(result.get(100), { amount: 100, paid: 0, overdue: 0, remain: 100 });
});

test('8) TZ/время: closedate с поздним временем + today с ранним временем → НЕ просрочен', () => {
  const inv = { id: 1, contactId: 100, opportunity: 100, stageId: STAGE_OVERDUE, closedate: '2026-04-30T23:59:59+03:00' };
  const todayEarly = new Date(2026, 3, 30, 0, 30, 0); // 2026-04-30 00:30 локально
  const result = aggregate([inv], todayEarly);
  assert.deepEqual(result.get(100), { amount: 100, paid: 0, overdue: 0, remain: 100 });
});

test('9) contactId == null — счёт игнорируется, не попадает в Map', () => {
  const invs = [
    { id: 1, contactId: null, opportunity: 999, stageId: STAGE_PAID, closedate: '2026-04-10' },
    { id: 2, contactId: 100, opportunity: 50, stageId: STAGE_PAID, closedate: '2026-04-10' },
  ];
  const result = aggregate(invs, today);
  assert.equal(result.size, 1);
  assert.deepEqual(result.get(100), { amount: 50, paid: 50, overdue: 0, remain: 0 });
  // null-контакт нигде не должен фигурировать
  assert.equal(result.has(null), false);
});

test('10) opportunity как строка → корректно складывается', () => {
  const inv = { id: 1, contactId: 100, opportunity: '1500.50', stageId: STAGE_PAID, closedate: '2026-04-10' };
  const result = aggregate([inv], today);
  assert.equal(result.get(100).paid, 1500.5);
});

test('11) closedate=null → счёт не помечается просроченным; aggregate(invoices, null) бросает понятную ошибку', () => {
  // 11a: счёт с closedate=null
  const inv = { id: 1, contactId: 100, opportunity: 100, stageId: 'DT31_5:S', closedate: null };
  const result = aggregate([inv], today);
  const acc = result.get(100);
  assert.equal(acc.overdue, 0, 'closedate=null → не overdue ни при каком today');
  assert.equal(acc.remain, 100, 'opp всё равно учитывается в remain');

  // 11b: aggregate(_, null) → throws
  assert.throws(
    () => aggregate([inv], null),
    /aggregator: today must be a valid Date or YYYY-MM-DD string/
  );

  // 11c: aggregate(_, 'invalid') → throws
  assert.throws(
    () => aggregate([inv], 'not-a-date'),
    /aggregator: today must be a valid Date or YYYY-MM-DD string/
  );
});
