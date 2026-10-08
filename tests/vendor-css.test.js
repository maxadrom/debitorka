'use strict';

// tests/vendor-css.test.js
// Smoke-тест: vendor/flatpickr.min.css должен существовать и быть подключён в index.html.
// Регрессия: без этого CSS календарь flatpickr рендерится одной строкой
// (дни недели и числа склеиваются, выбрать дату невозможно).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('index.html подключает vendor/flatpickr.min.css', () => {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  assert.match(
    html,
    /<link\s+rel="stylesheet"\s+href="vendor\/flatpickr\.min\.css"\s*\/?>/,
    'index.html должен содержать <link> на vendor/flatpickr.min.css',
  );
});

test('vendor/flatpickr.min.css существует', () => {
  assert.ok(
    existsSync(resolve(ROOT, 'vendor/flatpickr.min.css')),
    'файл vendor/flatpickr.min.css должен лежать в репозитории',
  );
});

test('vendor/flatpickr.min.css содержит ключевые селекторы сетки календаря', () => {
  const css = readFileSync(resolve(ROOT, 'vendor/flatpickr.min.css'), 'utf8');
  // Без этих селекторов календарь схлопывается в одну строку.
  const required = [
    '.flatpickr-calendar',
    '.flatpickr-days',
    '.dayContainer',
    '.flatpickr-day',
    '.flatpickr-weekday',
  ];
  for (const selector of required) {
    assert.ok(css.includes(selector), `flatpickr.min.css должен содержать ${selector}`);
  }
});

test('vendor/VERSIONS.txt фиксирует источник flatpickr.min.css', () => {
  const versions = readFileSync(resolve(ROOT, 'vendor/VERSIONS.txt'), 'utf8');
  assert.match(
    versions,
    /flatpickr\.min\.css\b/,
    'VERSIONS.txt должен документировать vendored CSS-файл flatpickr',
  );
});

test('flatpickr CSS подключён ДО styles.css (порядок каскада)', () => {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const idxFp = html.indexOf('vendor/flatpickr.min.css');
  const idxApp = html.indexOf('styles.css');
  assert.ok(idxFp >= 0 && idxApp >= 0, 'оба <link> должны присутствовать');
  assert.ok(
    idxFp < idxApp,
    'vendor/flatpickr.min.css должен подключаться до styles.css, чтобы локальные стили могли переопределять flatpickr',
  );
});
