'use strict';

// tests/xlsx-export.test.js
// Smoke-тесты xlsx-export.js: defaultFilename + exportReport через мок window.XLSX.
// Реальный vendor/xlsx.full.min.js НЕ подгружается — формат файла не валидируем.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportReport, defaultFilename } from '../modules/application/xlsx-export.js';

// ---------- Helpers ----------

function colLetter(c) {
  // Простая колонка A-E (тестовые данные используют 5 колонок).
  return String.fromCharCode(65 + c);
}

function buildSheet(data) {
  // Минимальная модель: для каждой пары (r, c) делаем addr = letter(c) + (r+1)
  // и кладём ячейку { t: 'auto', v: data[r][c] }.
  const ws = {};
  const rows = data.length;
  const cols = data.reduce((m, r) => Math.max(m, r.length), 0);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = data[r][c];
      if (v === undefined) continue;
      const addr = colLetter(c) + (r + 1);
      ws[addr] = { t: typeof v === 'number' ? 'n' : 's', v };
    }
  }
  ws['!ref'] = `A1:${colLetter(cols - 1)}${rows}`;
  return ws;
}

function makeMockXLSX() {
  const writeFileCalls = [];
  return {
    writeFileCalls,
    XLSX: {
      utils: {
        aoa_to_sheet(data) {
          return buildSheet(data);
        },
        book_new() { return {}; },
        book_append_sheet(wb, ws, name) { wb.sheet = { name, ws }; },
      },
      writeFile(wb, fname) { writeFileCalls.push({ wb, fname }); },
    },
  };
}

function setupWindow() {
  const mock = makeMockXLSX();
  globalThis.window = { XLSX: mock.XLSX };
  return mock;
}

function teardownWindow() {
  delete globalThis.window;
}

// ---------- Tests ----------

test('1) defaultFilename возвращает report_YYYY-MM-DD.xlsx с текущей датой', () => {
  const fn = defaultFilename();
  assert.match(fn, /^report_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('2) exportReport: числовые колонки 1..4 — t="n" для всех строк данных и для строки "Итого"', () => {
  const mock = setupWindow();
  try {
    const rows = [
      { name: 'Иванов И.', amount: 100, paid: 50, overdue: 0, remain: 50 },
      { name: 'Петров П.', amount: 200, paid: 200, overdue: 0, remain: 0 },
    ];
    const totals = { amount: 300, paid: 250, overdue: 0, remain: 50 };
    exportReport({ rows, totals, filename: 'test.xlsx' });

    const { ws } = mock.writeFileCalls[0].wb.sheet;
    // Строки данных в листе: r=0 — заголовок, r=1..rows.length — данные, r=rows.length+1 — Итого.
    for (let r = 1; r <= rows.length + 1; r += 1) {
      for (let c = 1; c <= 4; c += 1) {
        const addr = colLetter(c) + (r + 1);
        assert.equal(ws[addr].t, 'n', `${addr} должен иметь t === 'n'`);
      }
    }
    // Колонка A (ФИО) — у строк данных оставлена строкой (тип 's').
    for (let r = 1; r <= rows.length; r += 1) {
      const addr = 'A' + (r + 1);
      assert.equal(ws[addr].t, 's', `${addr} должен оставаться 's'`);
    }
  } finally {
    teardownWindow();
  }
});

test('3) exportReport вызывает writeFile с переданным filename', () => {
  const mock = setupWindow();
  try {
    exportReport({
      rows: [{ name: 'X', amount: 1, paid: 1, overdue: 0, remain: 0 }],
      totals: { amount: 1, paid: 1, overdue: 0, remain: 0 },
      filename: 'custom-name.xlsx',
    });
    assert.equal(mock.writeFileCalls.length, 1);
    assert.equal(mock.writeFileCalls[0].fname, 'custom-name.xlsx');
  } finally {
    teardownWindow();
  }
});

test('4) exportReport бросает понятную ошибку, если window.XLSX не загружен', () => {
  // Вариант 1: window есть, XLSX нет.
  globalThis.window = {};
  try {
    assert.throws(
      () => exportReport({
        rows: [],
        totals: { amount: 0, paid: 0, overdue: 0, remain: 0 },
        filename: 'x.xlsx',
      }),
      /XLSX global not loaded/,
    );
  } finally {
    teardownWindow();
  }
  // Вариант 2: window отсутствует совсем.
  assert.throws(
    () => exportReport({
      rows: [],
      totals: { amount: 0, paid: 0, overdue: 0, remain: 0 },
      filename: 'x.xlsx',
    }),
    /XLSX global not loaded/,
  );
});
