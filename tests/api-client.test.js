'use strict';

// tests/api-client.test.js
// Регресс-тесты портального режима api-client (BX24 JS SDK).
//
// Контекст: BX24 SDK-обёртка отдаёт `res.next(callback?)` как функцию-триггер
// автоподгрузки следующей страницы (инициирует ещё один REST-запрос), а НЕ
// индекс. Раньше bxCallMethod/bxCallBatch вызывали res.next() ради значения и
// под REST-квотой ~2 req/sec это давало каскад 503/CORS. См. patches/2026-04-30-14.19.md.
//
// Эти тесты эмулируют BX24 SDK через мок `window.BX24` и проверяют контракт:
//   - `next` в результате callMethod/callBatch равен undefined
//   - res.next() как функция НЕ вызывается ни разу
//
// Запуск: node --test tests/api-client.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

// api-client.js работает только в браузере. Чтобы импортировать его в Node,
// готовим минимальный globalThis.window до первого `import`.
function setupBrowserGlobals(bxStub) {
  globalThis.window = {
    BX24: bxStub,
    location: { href: 'http://localhost/' },
  };
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
}

function makeBxRes({ data, total, error = null, onNextCalled }) {
  return {
    error: () => error,
    data: () => data,
    total: () => total,
    // Если этот метод вызовут — пометит флаг и вернёт что-нибудь похожее на
    // «индекс», как если бы кто-то ошибочно ожидал число. Нам важно: его
    // НЕ должны вызывать.
    next: () => {
      if (typeof onNextCalled === 'function') onNextCalled();
      return 50;
    },
  };
}

test('1) bxCallMethod: не вызывает res.next() ради значения; next в результате — undefined', async () => {
  let nextCalled = false;
  const bxStub = {
    callMethod(method, params, cb) {
      assert.equal(method, 'crm.contact.list');
      assert.equal(params.start, 0);
      const res = makeBxRes({
        data: [{ ID: '1' }, { ID: '2' }],
        total: 100,
        onNextCalled: () => { nextCalled = true; },
      });
      cb(res);
    },
  };
  setupBrowserGlobals(bxStub);

  // Импортируем модуль ПОСЛЕ выставления window — иначе IS_DEV в env.js
  // зафиксируется до того, как мы подменим globals.
  // Кеш-busting через query: каждый тестовый файл импортируется один раз; нам
  // достаточно выставить globals перед import.
  const { callMethod } = await import('../modules/infrastructure/api-client.js');

  const out = await callMethod('crm.contact.list', { start: 0 });
  assert.deepEqual(out.result, [{ ID: '1' }, { ID: '2' }]);
  assert.equal(out.total, 100);
  assert.equal(out.next, undefined, 'next должен быть undefined (не вызывать res.next())');
  assert.equal(nextCalled, false, 'res.next() — функция-триггер, её НЕЛЬЗЯ вызывать ради значения');
});

test('2) bxCallBatch: per-entry next тоже undefined; res.next() в каждой записи не вызывается', async () => {
  // Этот тест отдельным файлом не запускаем заново — модуль уже импортирован
  // из теста #1 с тем же window.BX24. Поэтому переопределяем стаб «изнутри»:
  // но проще — поменять методы стаба напрямую через ссылку.
  let nextCallCount = 0;
  globalThis.window.BX24.callBatch = (commands, cb) => {
    // Имитируем результат BX24 как массив res-обёрток (по числу команд).
    const results = commands.map((_, i) =>
      makeBxRes({
        data: [{ ID: String(i * 10 + 1) }],
        total: 100,
        onNextCalled: () => { nextCallCount += 1; },
      })
    );
    cb(results, /* halt */ true);
  };

  const { callBatch } = await import('../modules/infrastructure/api-client.js');
  const out = await callBatch(
    [
      ['crm.contact.list', { start: 50 }],
      ['crm.contact.list', { start: 100 }],
    ],
    true
  );

  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 2);
  for (const entry of out) {
    assert.equal(entry.next, undefined, 'next в каждой записи должен быть undefined');
    assert.equal(entry.total, 100);
  }
  assert.equal(nextCallCount, 0, 'r.next() не должен вызываться ни в одной записи batch');
});

test('3) bxCallBatch halt=true: при error в одной из записей — бросает с префиксом "api-client: batch[<idx>] failed:"', async () => {
  // Стаб BX24.callBatch: вторая запись возвращает error()
  // (next не указываем — на error-ветке bxCallBatch отклоняется до чтения next)
  globalThis.window.BX24.callBatch = (commands, cb) => {
    const results = commands.map((_, i) => {
      if (i === 1) {
        return {
          error: () => ({ error_description: 'invoice not found', error: 'NOT_FOUND' }),
          data: () => null,
          total: () => undefined,
        };
      }
      return makeBxRes({ data: [{ ID: '1' }], total: 1, onNextCalled: () => {} });
    });
    cb(results, true);
  };

  const { callBatch } = await import('../modules/infrastructure/api-client.js');
  await assert.rejects(
    callBatch(
      [
        ['crm.contact.list', { start: 0 }],
        ['crm.contact.list', { start: 50 }],
      ],
      true
    ),
    (err) => /^api-client: batch\[1\] failed: invoice not found$/.test(err.message)
  );
});

test('5) toBitrixQuery: вложенный фильтр с операторами >=, <=, !=, @ и массивы', async () => {
  const { toBitrixQuery } = await import('../modules/infrastructure/api-client.js');
  const qs = toBitrixQuery({
    entityTypeId: 31,
    filter: {
      '>=closedate': '2026-10-01',
      '<=closedate': '2026-10-31',
      '!=stageId': 'DT31_5:D',
      '@assignedById': [483, 19],
    },
    select: ['id', 'contactId'],
    start: 50,
  });
  assert.equal(
    qs,
    'entityTypeId=31'
      + '&filter[%3E%3Dclosedate]=2026-10-01'
      + '&filter[%3C%3Dclosedate]=2026-10-31'
      + '&filter[!%3DstageId]=DT31_5%3AD'
      + '&filter[%40assignedById][0]=483&filter[%40assignedById][1]=19'
      + '&select[0]=id&select[1]=contactId'
      + '&start=50'
  );
});

test('6) toBitrixQuery: пустые params, undefined пропускается, null → пустая строка, кириллица кодируется', async () => {
  const { toBitrixQuery } = await import('../modules/infrastructure/api-client.js');
  assert.equal(toBitrixQuery({}), '');
  assert.equal(toBitrixQuery(undefined), '');
  assert.equal(toBitrixQuery({ a: undefined, b: null, c: 'Иванов & Ко' }), 'b=&c=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2%20%26%20%D0%9A%D0%BE');
});

test('7) parseBatchResponse: массив команд → массив {result,total}', async () => {
  const { parseBatchResponse } = await import('../modules/infrastructure/api-client.js');
  const json = {
    result: {
      result: [[{ ID: '1' }], [{ ID: '2' }]],
      result_error: [],
      result_total: [120, 120],
      result_next: [50, 100],
    },
  };
  const out = parseBatchResponse(json, 2);
  assert.deepEqual(out, [
    { result: [{ ID: '1' }], total: 120 },
    { result: [{ ID: '2' }], total: 120 },
  ]);
});

test('8) parseBatchResponse halt=true: result_error → throw "api-client: batch[key] failed: desc"', async () => {
  const { parseBatchResponse } = await import('../modules/infrastructure/api-client.js');
  const json = {
    result: {
      result: [{ items: [] }],
      result_error: { 1: { error: 'ACCESS_DENIED', error_description: 'Access denied.' } },
      result_total: [0],
    },
  };
  assert.throws(
    () => parseBatchResponse(json, 2),
    (err) => err.message === 'api-client: batch[1] failed: Access denied.' && err.code === 'ACCESS_DENIED'
  );
});

test('10) withRetry: 503 один раз → успех со 2-й попытки', async () => {
  const { withRetry } = await import('../modules/infrastructure/api-client.js');
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('api-client: crm.item.list failed: Service Unavailable');
      err.status = 503;
      throw err;
    }
    return 'ok';
  }, { delays: [0, 0] });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
});

test('11) withRetry: бизнес-ошибка (ACCESS_DENIED) — без повтора', async () => {
  const { withRetry } = await import('../modules/infrastructure/api-client.js');
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      const err = new Error('api-client: crm.item.list failed: Access denied');
      err.code = 'ACCESS_DENIED';
      err.status = 401;
      throw err;
    }, { delays: [0, 0] }),
    /Access denied/
  );
  assert.equal(calls, 1);
});

test('12) withRetry: QUERY_LIMIT_EXCEEDED и сеть повторяются, после 3 попыток ошибка пробрасывается', async () => {
  const { withRetry, isRetryable } = await import('../modules/infrastructure/api-client.js');
  assert.equal(isRetryable(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'OPERATION_TIME_LIMIT' })), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'INVALID_CREDENTIALS', status: 401 })), false);
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('limit'), { code: 'QUERY_LIMIT_EXCEEDED' });
    }, { delays: [0, 0] }),
    /limit/
  );
  assert.equal(calls, 3);
});

test('13) callMethod (портал): ответ 503 от BX24 один раз → повтор и успех', async () => {
  let calls = 0;
  globalThis.window.BX24.callMethod = (method, params, cb) => {
    calls += 1;
    if (calls === 1) {
      cb({ error: () => ({ status: 503, ex: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } }) });
      return;
    }
    cb(makeBxRes({ data: [{ ID: '7' }], total: 1 }));
  };
  const { callMethod } = await import('../modules/infrastructure/api-client.js');
  const out = await callMethod('crm.contact.list', {});
  assert.equal(calls, 2);
  assert.deepEqual(out.result, [{ ID: '7' }]);
});
