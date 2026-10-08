'use strict';

// modules/application/data-loader.js
// Оркестрация загрузки отчёта: item.list (счета за период) → постфильтр по дате оплаты →
// список ответственных периода → фильтр по ответственному → contact.list ‖ user.get (по id) →
// агрегация по контактам и по сотрудникам.
//
// Контракт:
//   loadReport(filters, apiClient = defaultApiClient)
//     → { byContact: Map, byAssignee: Map, contacts: Map<id, {fio}>,
//         users: Map<id, {fio, active}>, assignees: Array<{id, fio, active}>, totals }
//
// Параметр apiClient вынесен ради тестируемости (см. tests/data-loader.test.js).

import * as defaultApiClient from '../infrastructure/api-client.js';
import { BATCH_LIMIT } from '../infrastructure/api-client.js';
import { aggregate, totals, STAGE_PAID } from './aggregator.js';
import { logInfo, logDebug } from '../env.js';

const PAGE_SIZE = 50;
const ENTITY_TYPE_INVOICE = 31;
// Финальная неуспешная стадия («Не оплачен», semantics F) — отсекаем серверным фильтром.
const STAGE_FAILED = 'DT31_5:D';

const INVOICE_SELECT = [
  'id',
  'contactId',
  'assignedById',
  'opportunity',
  'stageId',
  'closedate',
  'ufCrmSmartInvoiceDatePay',
];

const CONTACT_SELECT = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'];

function buildFio(person) {
  // person от crm.contact.list или user.get (UPPER_SNAKE имена полей).
  return [person.LAST_NAME, person.NAME, person.SECOND_NAME]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Оборачивает ошибку шага в Error('data-loader: <step> failed: <msg>') с cause.
async function step(stepName, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`data-loader: ${stepName} failed: ${err && err.message ? err.message : err}`, { cause: err });
  }
}

const asArray = (x) => (Array.isArray(x) ? x : []);

// Все страницы списочного метода: первая — одиночным вызовом (ради total),
// остальные — через callBatch пачками по BATCH_LIMIT команд.
// Пагинация по total, а не по next (см. api-client.js про res.next в BX24).
async function fetchAll(apiClient, method, params, pickItems = asArray) {
  const r0 = await apiClient.callMethod(method, { ...params, start: 0 });
  if (typeof r0.total !== 'number') throw new Error('SDK did not return numeric total');
  const all = [...pickItems(r0.result)];
  const starts = [];
  for (let s = PAGE_SIZE; s < r0.total; s += PAGE_SIZE) starts.push(s);
  for (const part of chunk(starts, BATCH_LIMIT)) {
    const results = await apiClient.callBatch(part.map((start) => [method, { ...params, start }]));
    for (const entry of results) all.push(...pickItems(entry && entry.result));
  }
  logDebug(`[data-loader] ${method} total=${r0.total} batches=${Math.ceil(starts.length / BATCH_LIMIT)}`);
  return all;
}

async function loadContactsByIds(ids, apiClient) {
  const out = new Map();
  // Одна команда = до 50 ID, один batch = до 50 команд (2 500 контактов).
  const cmds = chunk(ids, PAGE_SIZE).map((part) => [
    'crm.contact.list',
    { filter: { ID: part }, select: CONTACT_SELECT },
  ]);
  for (const batchCmds of chunk(cmds, BATCH_LIMIT)) {
    for (const entry of await apiClient.callBatch(batchCmds)) {
      for (const c of asArray(entry && entry.result)) {
        const id = Number(c.ID);
        if (Number.isFinite(id)) out.set(id, { fio: buildFio(c) });
      }
    }
  }
  return out;
}

// Дата оплаты в диапазоне [from, to] (строки 'YYYY-MM-DD').
// У оплаченного счёта без ufCrmSmartInvoiceDatePay датой оплаты считается срок
// оплаты (closedate) — решение пользователя 2026-10-08. Неоплаченный без даты → отсекаем.
function isDatePayInRange(inv, from, to) {
  const v = inv.ufCrmSmartInvoiceDatePay || (inv.stageId === STAGE_PAID ? inv.closedate : null);
  if (typeof v !== 'string' || v.length < 10) return false;
  const dp = v.slice(0, 10);
  return dp >= from && dp <= to;
}

// Пользователи по ID, включая уволенных (большинство счетов — на уволенных сотрудниках).
// Каждый id из ids есть в результате: не найденные user.get — «Пользователь #id», неактивные.
async function loadUsersByIds(ids, apiClient) {
  const out = new Map();
  if (ids.length === 0) return out;
  for (const u of await fetchAll(apiClient, 'user.get', { FILTER: { ID: ids } })) {
    const id = Number(u.ID);
    if (Number.isFinite(id)) out.set(id, { fio: buildFio(u) || `Пользователь #${id}`, active: u.ACTIVE !== false });
  }
  for (const id of ids) {
    if (!out.has(id)) out.set(id, { fio: `Пользователь #${id}`, active: false });
  }
  return out;
}

const collator = new Intl.Collator('ru', { sensitivity: 'base' });

/**
 * Главный загрузчик отчёта.
 * Ответственный фильтруется на клиенте: список в фильтре — это ответственные
 * счетов за период (без учёта выбора), для него нужны все счета периода.
 * @param {{assignedById?:Array<number>, closedateFrom:string, closedateTo:string, datePayFrom?:string|null, datePayTo?:string|null}} filters
 * @param {{callMethod:Function, callBatch:Function}} [apiClient]
 */
export async function loadReport(filters, apiClient = defaultApiClient) {
  const t0 = performance.now();
  if (!filters || !filters.closedateFrom || !filters.closedateTo) {
    throw new Error('data-loader: loadReport: closedate range is required');
  }

  const allInvoices = await step('invoices', () => fetchAll(apiClient, 'crm.item.list', {
    entityTypeId: ENTITY_TYPE_INVOICE,
    filter: {
      '>=closedate': filters.closedateFrom,
      '<=closedate': filters.closedateTo,
      '!=stageId': STAGE_FAILED,
    },
    select: INVOICE_SELECT,
  }, (r) => asArray(r && r.items)));

  const hasDatePay = Boolean(filters.datePayFrom || filters.datePayTo);
  const payFrom = filters.datePayFrom || '0000-00-00';
  const payTo = filters.datePayTo || '9999-12-31';
  // Счета без contactId — на компанию без контакта; в отчёт «по контактам» не входят.
  // Вкладка «по сотрудникам» считается по тем же счетам, чтобы «Итого» совпадали.
  // Счёт без ответственного — ключ 0 («Без ответственного»).
  const periodInvoices = allInvoices
    .filter((inv) => (!hasDatePay || isDatePayInRange(inv, payFrom, payTo)) && inv.contactId != null)
    .map((inv) => ({ ...inv, assignedById: Number(inv.assignedById) || 0 }));

  const selected = Array.isArray(filters.assignedById) ? filters.assignedById : [];
  const selectedSet = new Set(selected);
  const invoices = selectedSet.size === 0
    ? periodInvoices
    : periodInvoices.filter((inv) => selectedSet.has(inv.assignedById));
  logDebug(`[data-loader] invoices kept=${invoices.length}/${allInvoices.length}`);

  const periodAssigneeIds = new Set(periodInvoices.map((inv) => inv.assignedById).filter((id) => id > 0));
  // Выбранные без счетов в периоде остаются в списке, чтобы выбор можно было снять.
  const userIds = [...new Set([...periodAssigneeIds, ...selected])];
  const contactIds = [...new Set(invoices.map((inv) => Number(inv.contactId)))].filter(Number.isFinite);
  const [contacts, users] = await Promise.all([
    step('contacts-by-id', () => loadContactsByIds(contactIds, apiClient)),
    step('users-by-id', () => loadUsersByIds(userIds, apiClient)),
  ]);

  const assignees = userIds
    .map((id) => ({ id, ...users.get(id) }))
    .sort((a, b) => collator.compare(a.fio, b.fio));

  const today = new Date();
  const byContact = aggregate(invoices, today);
  const byAssignee = aggregate(invoices, today, 'assignedById');
  logInfo(`[data-loader] loadReport done in ${(performance.now() - t0).toFixed(0)}ms contacts=${byContact.size} assignees=${byAssignee.size}`);
  return { byContact, byAssignee, contacts, users, assignees, totals: totals(byContact) };
}
