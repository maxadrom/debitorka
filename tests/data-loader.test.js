'use strict';

// tests/data-loader.test.js
// Smoke-тесты loadReport через DI-апи-клиент (mock).
// REST-вызовы не делаются — каждый тест строит mockApiClient под сценарий.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadReport } from '../modules/application/data-loader.js';

// ---------- Helpers ----------

function paidInv(id, contactId, opp, closedate = '2026-04-10', extra = {}) {
  return {
    id,
    contactId,
    opportunity: opp,
    stageId: 'DT31_5:P',
    closedate,
    ufCrmSmartInvoiceDatePay: null,
    ...extra,
  };
}

function openInv(id, contactId, opp, closedate = '2026-04-25', extra = {}) {
  return {
    id,
    contactId,
    opportunity: opp,
    stageId: 'DT31_5:S',
    closedate,
    ufCrmSmartInvoiceDatePay: null,
    ...extra,
  };
}

function contactRow(id, last = 'Иванов', first = 'Иван', second = '', assigned = 19) {
  return {
    ID: String(id),
    LAST_NAME: last,
    NAME: first,
    SECOND_NAME: second,
    ASSIGNED_BY_ID: String(assigned),
  };
}

// Создаёт mock с журналом вызовов и набором ответов.
// Batch из crm.contact.list (шаг contacts-by-id) по умолчанию отвечается
// по командам через plan.contact(params) или plan.method('crm.contact.list', params);
// в журнал он попадает как { kind: 'batch', method: 'batch:crm.contact.list' }.
function makeMock(plan) {
  const calls = [];
  return {
    calls,
    async callMethod(method, params) {
      calls.push({ kind: 'method', method, params });
      const resp = plan.method ? plan.method(method, params, calls.length) : null;
      if (!resp) throw new Error(`mock: unexpected callMethod(${method})`);
      if (resp.throw) throw resp.throw;
      return resp;
    },
    async callBatch(commands, halt) {
      const first = Array.isArray(commands) ? commands[0] : Object.values(commands)[0];
      const batchMethod = first && first[0];
      calls.push({ kind: 'batch', method: `batch:${batchMethod}`, count: Array.isArray(commands) ? commands.length : Object.keys(commands).length, commands, halt });
      if (batchMethod === 'crm.contact.list' && !plan.contactBatch) {
        const answer = plan.contact || ((params) => plan.method && plan.method('crm.contact.list', params));
        return commands.map(([, params]) => {
          const resp = answer(params);
          if (!resp) throw new Error('mock: unexpected crm.contact.list in batch');
          return resp;
        });
      }
      const resp = plan.contactBatch && batchMethod === 'crm.contact.list'
        ? plan.contactBatch(commands, halt)
        : (plan.batch ? plan.batch(commands, halt, calls.length) : null);
      if (!resp) throw new Error('mock: unexpected callBatch');
      if (resp.throw) throw resp.throw;
      return resp;
    },
  };
}

const APR = {
  assignedById: [],
  closedateFrom: '2026-04-01',
  closedateTo: '2026-04-30',
  datePayFrom: null,
  datePayTo: null,
};

// ---------- Tests ----------

test('1) без фильтра по ответственному: item.list → batch contact.list (ID:[...]) без @contactId', async () => {
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        // Подтверждаем: @contactId НЕ передан.
        assert.equal(params.start, 0);
        assert.equal('@contactId' in params.filter, false);
        return {
          result: { items: [openInv(1, 100, 1000)] },
          total: 1,
          next: undefined,
        };
      }
      if (method === 'crm.contact.list') {
        return { result: [contactRow(100)], total: 1, next: undefined };
      }
      return null;
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.equal(out.byContact.size, 1);
  assert.equal(out.contacts.get(100).fio, 'Иванов Иван');
  // Последовательность: item.list, затем batch из contact.list (без одиночных contact.list).
  assert.deepEqual(mock.calls.map((c) => c.method), ['crm.item.list', 'batch:crm.contact.list']);
});

test('2) с фильтром по ответственному: @assignedById НЕ уходит на сервер, счета фильтруются на клиенте', async () => {
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        // Список ответственных строится по всем счетам периода → фильтр не на сервере.
        assert.equal('@assignedById' in params.filter, false);
        return {
          result: { items: [
            openInv(1, 100, 1000, '2026-04-25', { assignedById: 7 }),
            openInv(2, 101, 500, '2026-04-25', { assignedById: 8 }),
          ] },
          total: 2,
        };
      }
      if (method === 'user.get') {
        assert.deepEqual(params.FILTER.ID.sort((x, y) => x - y), [7, 8]);
        return { result: [
          { ID: '7', LAST_NAME: 'Кузнецова', NAME: 'Ольга', ACTIVE: false },
          { ID: '8', LAST_NAME: 'Андреев', NAME: 'Алексей', ACTIVE: true },
        ], total: 2 };
      }
      return null;
    },
    contact(params) {
      assert.deepEqual(params.filter.ID, [100]); // ФИО — только для оставшихся счетов
      return { result: [contactRow(100)], total: 1 };
    },
  });
  const out = await loadReport({ ...APR, assignedById: [7] }, mock);
  assert.deepEqual([...out.byContact.keys()], [100]);
  assert.deepEqual([...out.byAssignee.keys()], [7]);
  // В списке фильтра — все ответственные периода, уволенные помечены active=false.
  assert.deepEqual(out.assignees, [
    { id: 8, fio: 'Андреев Алексей', active: true },
    { id: 7, fio: 'Кузнецова Ольга', active: false },
  ]);
  assert.equal(out.totals.amount, 1000);
});

test('3) постфильтрация по ufCrmSmartInvoiceDatePay: оставляет только в диапазоне', async () => {
  const invs = [
    openInv(1, 100, 100, '2026-04-10', { ufCrmSmartInvoiceDatePay: null }),
    openInv(2, 100, 200, '2026-04-15', { ufCrmSmartInvoiceDatePay: '2026-04-20' }), // в диапазоне
    openInv(3, 100, 300, '2026-04-25', { ufCrmSmartInvoiceDatePay: '2026-05-15' }), // вне диапазона
  ];
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') return { result: { items: invs }, total: invs.length, next: undefined };
      if (method === 'crm.contact.list') return { result: [contactRow(100)], total: 1, next: undefined };
      return null;
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: '2026-04-01',
    datePayTo: '2026-04-30',
  };
  const out = await loadReport(filters, mock);
  // В агрегате остаётся ровно одна сумма из счёта #2.
  assert.equal(out.byContact.get(100).amount, 200);
});

test('3b) оплаченный без даты оплаты → дата оплаты = срок оплаты; неоплаченный без даты отсекается', async () => {
  const invs = [
    paidInv(1, 100, 100, '2026-04-10'), // closedate в диапазоне оплаты → попадает
    paidInv(2, 100, 200, '2026-04-02'), // closedate вне диапазона оплаты → отсекается
    openInv(3, 100, 400, '2026-04-12'), // не оплачен, даты оплаты нет → отсекается
    paidInv(4, 100, 800, '2026-04-12', { ufCrmSmartInvoiceDatePay: '2026-04-01' }), // своя дата приоритетнее
  ];
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') return { result: { items: invs }, total: invs.length };
      return null;
    },
    contact: () => ({ result: [contactRow(100)], total: 1 }),
  });
  const out = await loadReport({ ...APR, datePayFrom: '2026-04-05', datePayTo: '2026-04-30' }, mock);
  assert.equal(out.byContact.get(100).amount, 100);
});

test('4) пагинация total=120: первый одиночный вызов (start=0) + 1 batch на 2 команды (start=50, 100)', async () => {
  const allItems = Array.from({ length: 120 }, (_, i) => openInv(i + 1, 100 + i, 10));
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        // Первый вызов с start=0
        assert.equal(params.start, 0);
        return { result: { items: allItems.slice(0, 50) }, total: 120, next: 50 };
      }
      if (method === 'crm.contact.list') {
        // Берётся контакт по уникальным id (120 шт).
        const ids = params.filter.ID;
        return { result: ids.map((id) => contactRow(Number(id))), total: ids.length, next: undefined };
      }
      return null;
    },
    batch(commands) {
      // Ожидаем 2 команды: start=50 и start=100
      assert.equal(commands.length, 2);
      assert.equal(commands[0][1].start, 50);
      assert.equal(commands[1][1].start, 100);
      return [
        { result: { items: allItems.slice(50, 100) }, total: 120, next: 100 },
        { result: { items: allItems.slice(100, 120) }, total: 120, next: undefined },
      ];
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.equal(out.byContact.size, 120);
  // Должен быть ровно 1 batch счетов и 1 одиночный item.list.
  const batchCalls = mock.calls.filter((c) => c.method === 'batch:crm.item.list');
  const itemListCalls = mock.calls.filter((c) => c.method === 'crm.item.list');
  assert.equal(batchCalls.length, 1);
  assert.equal(itemListCalls.length, 1);
});

test('5) большой объём total=1500: 1 одиночный вызов + 1 batch на 29 команд', async () => {
  const total = 1500;
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        return { result: { items: Array.from({ length: 50 }, (_, i) => openInv(i + 1, 200, 1)) }, total, next: 50 };
      }
      if (method === 'crm.contact.list') {
        return { result: [contactRow(200)], total: 1, next: undefined };
      }
      return null;
    },
    batch(commands) {
      // pages = ceil(1500/50) = 30. Минус первая = 29 команд.
      assert.equal(commands.length, 29);
      // Все стартовые индексы корректны: 50, 100, …, 1450
      const starts = commands.map((c) => c[1].start);
      assert.deepEqual(starts, Array.from({ length: 29 }, (_, i) => (i + 1) * 50));
      return commands.map(() => ({ result: { items: Array.from({ length: 50 }, (_, i) => openInv(1000 + i, 200, 1)) }, total, next: undefined }));
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.equal(out.byContact.get(200).amount, 1500); // 1500 счетов по 1
});

test('6) ошибка crm.item.list → loadReport бросает с префиксом "data-loader: invoices failed"', async () => {
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') return { throw: new Error('REST 401 unauthorized') };
      return null;
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  await assert.rejects(
    () => loadReport(filters, mock),
    (err) => {
      assert.match(err.message, /^data-loader: invoices failed:/);
      assert.ok(err.cause instanceof Error);
      return true;
    }
  );
});

test('7) ошибка batch → префикс "data-loader: invoices failed"', async () => {
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') {
        return { result: { items: [openInv(1, 100, 1)] }, total: 200, next: 50 };
      }
      if (method === 'crm.contact.list') return { result: [contactRow(100)], total: 1, next: undefined };
      return null;
    },
    batch() {
      return { throw: new Error('REST timeout') };
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  await assert.rejects(
    () => loadReport(filters, mock),
    (err) => {
      assert.match(err.message, /^data-loader: invoices failed:/);
      return true;
    }
  );
});

test('8) счета с contactId == null отфильтрованы перед contacts-by-id (batch) и не агрегированы', async () => {
  const items = [
    openInv(1, null, 999),
    openInv(2, 100, 50),
    openInv(3, null, 888),
  ];
  let observedIdsBatch = null;
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        return { result: { items }, total: items.length, next: undefined };
      }
      if (method === 'crm.contact.list') {
        observedIdsBatch = params.filter.ID;
        return { result: [contactRow(100)], total: 1, next: undefined };
      }
      return null;
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.equal(out.byContact.size, 1);
  assert.equal(out.byContact.get(100).amount, 50);
  // contacts-by-id должен запрашиваться только по 100, не по null — и только через batch.
  assert.deepEqual(observedIdsBatch, [100]);
  assert.equal(mock.calls.some((c) => c.kind === 'method' && c.method === 'crm.contact.list'), false);
});

test('11) total отсутствует на crm.item.list → loadReport бросает с префиксом invoices', async () => {
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') {
        return { result: { items: [openInv(1, 100, 1000)] } /* total отсутствует — нарушение контракта SDK */ };
      }
      return null;
    },
  });
  const filters = {
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  await assert.rejects(
    loadReport(filters, mock),
    (err) => /^data-loader: invoices failed: SDK did not return numeric total$/.test(err.message),
  );
});

test('12a) пагинация на границе: total === firstItems.length → batch не вызывается', async () => {
  // total = 50, первая страница уже содержит все 50 → второго запроса быть не должно.
  const items = Array.from({ length: 50 }, (_, i) => openInv(i + 1, 100 + i, 1000));
  let batchCalled = false;
  const mock = {
    async callMethod(method, params) {
      if (method === 'crm.item.list') {
        return { result: { items }, total: 50, next: undefined };
      }
      throw new Error('mock: unexpected ' + method);
    },
    async callBatch(commands) {
      if (commands[0][0] === 'crm.contact.list') {
        return commands.map(([, p]) => ({ result: p.filter.ID.map((id) => contactRow(id, 'Контакт', 'Имя', '', 19)), total: p.filter.ID.length }));
      }
      batchCalled = true;
      throw new Error('mock: invoices batch should not be invoked when total <= firstItems.length');
    },
  };
  const filters = {
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.equal(batchCalled, false, 'batch не должен был вызваться');
  assert.equal(out.byContact.size, 50);
});

test('12b) пагинация за границей: total=100, firstItems.length=50 → ровно 1 batch с одной командой start=50', async () => {
  const firstItems = Array.from({ length: 50 }, (_, i) => openInv(i + 1, 100 + i, 1000));
  const secondItems = Array.from({ length: 50 }, (_, i) => openInv(i + 51, 200 + i, 1000));
  let batchCommands = null;
  const mock = {
    async callMethod(method, params) {
      if (method === 'crm.item.list') {
        // только первый одиночный вызов — start=0.
        assert.equal(params.start, 0);
        return { result: { items: firstItems }, total: 100, next: undefined };
      }
      throw new Error('mock: unexpected ' + method);
    },
    async callBatch(commands) {
      if (commands[0][0] === 'crm.contact.list') {
        return commands.map(([, p]) => ({ result: p.filter.ID.map((id) => contactRow(id, 'Контакт', 'Имя', '', 19)), total: p.filter.ID.length }));
      }
      batchCommands = commands;
      assert.equal(commands.length, 1, 'ровно одна команда — start=50');
      assert.equal(commands[0][0], 'crm.item.list');
      assert.equal(commands[0][1].start, 50);
      return [{ result: { items: secondItems }, total: 100, next: undefined }];
    },
  };
  const filters = {
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  const out = await loadReport(filters, mock);
  assert.ok(batchCommands, 'callBatch должен был вызваться');
  assert.equal(out.byContact.size, 100);
});

test('14) loadReport без closedateFrom/To → бросает с понятным сообщением до REST-вызова', async () => {
  let restCalls = 0;
  const mock = {
    async callMethod() { restCalls += 1; return { result: { items: [] }, total: 0 }; },
    async callBatch() { restCalls += 1; return []; },
  };

  // 14a: оба поля пусты
  await assert.rejects(
    loadReport({ closedateFrom: null, closedateTo: null }, mock),
    /data-loader: loadReport: closedate range is required/
  );
  assert.equal(restCalls, 0, 'REST-вызов не должен быть сделан при невалидных фильтрах');

  // 14b: только closedateFrom пуст
  await assert.rejects(
    loadReport({ closedateFrom: null, closedateTo: '2026-04-30' }, mock),
    /data-loader: loadReport: closedate range is required/
  );
  assert.equal(restCalls, 0);

  // 14c: только closedateTo пуст
  await assert.rejects(
    loadReport({ closedateFrom: '2026-04-01', closedateTo: '' }, mock),
    /data-loader: loadReport: closedate range is required/
  );
  assert.equal(restCalls, 0);

  // 14d: filters === null/undefined
  await assert.rejects(
    loadReport(null, mock),
    /data-loader: loadReport: closedate range is required/
  );
  assert.equal(restCalls, 0);
});

test('15) выбранный ответственный без счетов в периоде остаётся в списке; счёт без ответственного → ключ 0', async () => {
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        return { result: { items: [openInv(1, 100, 1000, '2026-04-25', { assignedById: null })] }, total: 1 };
      }
      if (method === 'user.get') {
        assert.deepEqual(params.FILTER.ID, [77]);
        return { result: [{ ID: '77', LAST_NAME: 'Иванов', NAME: 'Пётр', ACTIVE: true }], total: 1 };
      }
      return null;
    },
    contact: () => ({ result: [], total: 0 }),
  });
  const out = await loadReport({ ...APR, assignedById: [77] }, mock);
  assert.deepEqual(out.assignees, [{ id: 77, fio: 'Иванов Пётр', active: true }]);
  assert.equal(out.byContact.size, 0); // счёт без ответственного не подходит под выбор 77

  const all = await loadReport(APR, makeMock({
    method(method) {
      if (method === 'crm.item.list') {
        return { result: { items: [openInv(1, 100, 1000, '2026-04-25', { assignedById: null })] }, total: 1 };
      }
      return null; // user.get не вызывается: ответственных нет
    },
    contact: () => ({ result: [contactRow(100)], total: 1 }),
  }));
  assert.deepEqual([...all.byAssignee.keys()], [0]);
  assert.deepEqual(all.assignees, []);
});

test('16) без фильтра по ответственному: @assignedById не передаётся в filter', async () => {
  let itemListSeen = null;
  const mock = makeMock({
    method(method, params) {
      if (method === 'crm.item.list') {
        itemListSeen = params;
        return { result: { items: [openInv(1, 100, 1000)] }, total: 1, next: undefined };
      }
      if (method === 'crm.contact.list') {
        return { result: [contactRow(100)], total: 1, next: undefined };
      }
      return null;
    },
  });
  const filters = {
    assignedById: [],
    closedateFrom: '2026-04-01',
    closedateTo: '2026-04-30',
    datePayFrom: null,
    datePayTo: null,
  };
  await loadReport(filters, mock);
  assert.ok(itemListSeen, 'crm.item.list должен быть вызван');
  // Защита от регрессии: пустой массив не должен попасть в фильтр — Bitrix
  // интерпретирует @assignedById: [] как «никого» и вернул бы 0 строк отчёта.
  assert.equal('@assignedById' in itemListSeen.filter, false);
});

// ---------- contacts-by-id через batch ----------

const OCT = {
  assignedById: [],
  closedateFrom: '2026-10-01',
  closedateTo: '2026-10-31',
  datePayFrom: null,
  datePayTo: null,
};

test('17) 120 контактов → 1 batch на 3 команды crm.contact.list, без одиночных crm.contact.list', async () => {
  const items = Array.from({ length: 50 }, (_, i) => openInv(i + 1, 1000 + i, 1));
  const items2 = Array.from({ length: 50 }, (_, i) => openInv(i + 51, 1050 + i, 1));
  const items3 = Array.from({ length: 20 }, (_, i) => openInv(i + 101, 1100 + i, 1));
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') return { result: { items }, total: 120 };
      return null;
    },
    batch(commands) {
      assert.equal(commands[0][0], 'crm.item.list');
      return [{ result: { items: items2 } }, { result: { items: items3 } }];
    },
    contact(params) {
      return { result: params.filter.ID.map((id) => contactRow(id)), total: params.filter.ID.length };
    },
  });
  const out = await loadReport(OCT, mock);
  assert.equal(out.contacts.size, 120);
  const contactBatches = mock.calls.filter((c) => c.method === 'batch:crm.contact.list');
  assert.equal(contactBatches.length, 1);
  assert.equal(contactBatches[0].count, 3);
  assert.deepEqual(contactBatches[0].commands.map(([, p]) => p.filter.ID.length), [50, 50, 20]);
  assert.equal(mock.calls.some((c) => c.kind === 'method' && c.method === 'crm.contact.list'), false);
});

test('18) ошибка batch контактов → префикс "data-loader: contacts-by-id failed"', async () => {
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') return { result: { items: [openInv(1, 100, 1)] }, total: 1 };
      return null;
    },
    contactBatch() {
      return { throw: new Error('api-client: batch[0] failed: Access denied') };
    },
  });
  await assert.rejects(
    loadReport(OCT, mock),
    /^Error: data-loader: contacts-by-id failed: api-client: batch\[0\] failed: Access denied$/
  );
});

test('19) byAssignee и byContact считаются по одним счетам: итоги совпадают', async () => {
  const mock = makeMock({
    method(method) {
      if (method === 'crm.item.list') {
        return { result: { items: [
          paidInv(1, 100, 300, '2026-04-10', { assignedById: 5 }),
          openInv(2, 100, 200, '2026-04-25', { assignedById: 6 }),
          openInv(3, 101, 100, '2026-04-25', { assignedById: 5 }),
        ] }, total: 3 };
      }
      if (method === 'user.get') return { result: [{ ID: '5', NAME: 'А' }, { ID: '6', NAME: 'Б' }], total: 2 };
      return null;
    },
    contact: (params) => ({ result: params.filter.ID.map((id) => contactRow(id)), total: params.filter.ID.length }),
  });
  const out = await loadReport(APR, mock);
  // Апрель 2026 уже прошёл → неоплаченные просрочены.
  assert.deepEqual(out.byAssignee.get(5), { amount: 400, paid: 300, overdue: 100, remain: 100 });
  assert.deepEqual(out.byAssignee.get(6), { amount: 200, paid: 0, overdue: 200, remain: 200 });
  const sum = [...out.byAssignee.values()].reduce((acc, v) => acc + v.amount, 0);
  assert.equal(sum, out.totals.amount);

});
