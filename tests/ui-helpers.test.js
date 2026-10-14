'use strict';

// tests/ui-helpers.test.js
// Открытие карточки контакта: на портале — BX24.openPath (метода openSlider в SDK нет),
// при ошибке слайдера — новая вкладка по домену портала.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openContactSlider } from '../modules/presentation/ui-helpers.js';

afterEach(() => { delete globalThis.window; });

function portalWindow(openPathResult) {
  const calls = { openPath: [], open: [] };
  globalThis.window = {
    BX24: {
      openPath: (path, cb) => { calls.openPath.push(path); if (openPathResult) cb(openPathResult); },
      getDomain: () => 'example.bitrix24.ru',
    },
    open: (...args) => calls.open.push(args),
  };
  return calls;
}

test('1) портал: карточка контакта открывается через BX24.openPath', () => {
  const calls = portalWindow({ result: 'close' });
  openContactSlider(42);
  assert.deepEqual(calls.openPath, ['/crm/contact/details/42/']);
  assert.equal(calls.open.length, 0);
});

test('2) портал: слайдер не открылся → новая вкладка на домене портала', () => {
  const calls = portalWindow({ result: 'error', errorCode: 'MOBILE' });
  openContactSlider(42);
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0][0], 'https://example.bitrix24.ru/crm/contact/details/42/');
});
