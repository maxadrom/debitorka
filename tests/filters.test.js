'use strict';

// tests/filters.test.js
// Состояние фильтров и URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultFilters, parseFromUrl, serializeToUrl } from '../modules/application/filters.js';

const NOW = new Date(2026, 9, 5);

test('1) defaultFilters: текущий месяц по closedate, без ответственных и даты оплаты', () => {
  assert.deepEqual(defaultFilters(NOW), {
    assignedById: [],
    closedateFrom: '2026-10-01',
    closedateTo: '2026-10-31',
    datePayFrom: null,
    datePayTo: null,
  });
});

test('2) parseFromUrl: устаревший excludeClosed игнорируется', () => {
  assert.deepEqual(parseFromUrl(new URLSearchParams('excludeClosed=0'), NOW), defaultFilters(NOW));
});

test('3) serializeToUrl: дефолт пишет только closedate', () => {
  assert.deepEqual([...serializeToUrl(defaultFilters(NOW)).keys()], ['closedateFrom', 'closedateTo']);
});

test('4) round-trip: serialize → parse сохраняет все поля', () => {
  const f = {
    assignedById: [19, 483],
    closedateFrom: '2026-10-01',
    closedateTo: '2026-10-31',
    datePayFrom: '2026-10-05',
    datePayTo: null,
  };
  assert.deepEqual(parseFromUrl(serializeToUrl(f), NOW), f);
});
