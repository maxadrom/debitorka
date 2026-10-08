'use strict';

// modules/application/aggregator.js
// Чистая функция агрегации счетов по ключу (contactId или assignedById).
// Никакого I/O, никакого DOM, никакого console.* — функция вызывается на каждом
// ререндере, любые сайд-эффекты замусорят логи.
//
// Контракт invoice'а:
//   { id, contactId, opportunity, stageId, closedate, ufCrmSmartInvoiceDatePay? }
// closedate приходит из crm.item.list в формате 'YYYY-MM-DDTHH:MM:SS+TZ' или Date.
// Сравнение «просрочен ли» — строго по дате без времени и TZ.

export const STAGE_PAID = 'DT31_5:P';

// dateOnly(input) → Date в локальной TZ с занулённым временем.
// Принимает ISO-строку или Date.
function dateOnly(input) {
  if (input instanceof Date) {
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  if (typeof input === 'string' && input.length >= 10) {
    const y = Number(input.slice(0, 4));
    const m = Number(input.slice(5, 7));
    const d = Number(input.slice(8, 10));
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      return new Date(y, m - 1, d);
    }
  }
  // null/undefined/невалидная строка → null. Вызывающая сторона решает, что делать.
  return null;
}

function toNumber(value) {
  // crm.item.list иногда отдаёт opportunity как строку ('1234.56') или число.
  // Пустая строка даёт Number('') === 0 — это и нужно.
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Агрегация массива счетов по полю keyField (contactId — по клиентам, assignedById — по сотрудникам).
 * @param {Array<{contactId:number|string|null, opportunity:number|string, stageId:string, closedate:string|Date}>} invoices
 * @param {Date|string} today — дата отсечки для is_overdue (нормализуется через dateOnly)
 * @param {string} [keyField='contactId']
 * @returns {Map<number, {amount:number, paid:number, overdue:number, remain:number}>}
 */
export function aggregate(invoices, today, keyField = 'contactId') {
  const result = new Map();
  const todayDate = dateOnly(today);
  if (todayDate === null) {
    throw new Error('aggregator: today must be a valid Date or YYYY-MM-DD string');
  }

  for (const inv of invoices) {
    // Счета без ключа (например, без contactId — на компанию без контакта) не агрегируются.
    if (inv[keyField] == null) continue;

    const key = Number(inv[keyField]);
    if (!Number.isFinite(key)) continue;

    const opp = toNumber(inv.opportunity);
    const isPaid = inv.stageId === STAGE_PAID;
    const closeDate = dateOnly(inv.closedate);
    const isOverdue = !isPaid && closeDate !== null && closeDate < todayDate;

    const acc = result.get(key) ?? { amount: 0, paid: 0, overdue: 0, remain: 0 };
    acc.amount += opp;
    if (isPaid) {
      acc.paid += opp;
    } else {
      acc.remain += opp;
      if (isOverdue) acc.overdue += opp;
    }
    result.set(key, acc);
  }

  return result;
}

/**
 * Сумма по всем контактам (для строки «Итого»).
 * @param {Map<number, {amount:number, paid:number, overdue:number, remain:number}>} aggregates
 * @returns {{amount:number, paid:number, overdue:number, remain:number}}
 */
export function totals(aggregates) {
  const sum = { amount: 0, paid: 0, overdue: 0, remain: 0 };
  for (const v of aggregates.values()) {
    sum.amount += v.amount;
    sum.paid += v.paid;
    sum.overdue += v.overdue;
    sum.remain += v.remain;
  }
  return sum;
}

/**
 * «% сбора дебиторки» = Оплачено / Должен всего (доля от 0 до 1).
 * @returns {number|null} null, если сумма к оплате нулевая
 */
export function collectionRate(sum) {
  return sum.amount > 0 ? sum.paid / sum.amount : null;
}
