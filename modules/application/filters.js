'use strict';

// modules/application/filters.js
// Состояние фильтров отчёта + сериализация в URL и обратно.
// Никакого DOM (это application-слой), только данные и URL.

import { logDebug, logWarn } from '../env.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date → 'YYYY-MM-DD' в локальной TZ. */
export function toDateKey(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isValidDateKey(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  // Date.parse('2026-04-30') понимает ISO. Проверяем, что результат — число.
  return !Number.isNaN(Date.parse(s));
}

function validateRange(field, fromRaw, toRaw) {
  // Возвращает { from, to } или { from: null, to: null } при нарушении.
  const from = isValidDateKey(fromRaw) ? fromRaw : null;
  const to = isValidDateKey(toRaw) ? toRaw : null;
  if (fromRaw && !from) {
    logWarn(`[filters] invalid value, falling back to default`, { field: `${field}From`, raw: fromRaw });
  }
  if (toRaw && !to) {
    logWarn(`[filters] invalid value, falling back to default`, { field: `${field}To`, raw: toRaw });
  }
  if (from && to && from > to) {
    logWarn(`[filters] invalid ${field} range, falling back to default`, { from, to });
    return { from: null, to: null };
  }
  return { from, to };
}

/**
 * Дефолтные значения фильтров: текущий месяц по closedate.
 */
export function defaultFilters(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  return {
    assignedById: [],
    closedateFrom: toDateKey(new Date(y, m, 1)),
    closedateTo: toDateKey(new Date(y, m + 1, 0)),
    datePayFrom: null,
    datePayTo: null,
  };
}

/**
 * Парсинг фильтров из URLSearchParams. Невалидные поля валятся к дефолту локально,
 * остальные сохраняются.
 */
export function parseFromUrl(searchParams, now = new Date()) {
  const def = defaultFilters(now);

  const assignedById = searchParams.getAll('assignedById')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const closeRange = validateRange(
    'closedate',
    searchParams.get('closedateFrom'),
    searchParams.get('closedateTo')
  );

  const payRange = validateRange(
    'datePay',
    searchParams.get('datePayFrom'),
    searchParams.get('datePayTo')
  );

  const out = {
    assignedById,
    closedateFrom: closeRange.from || def.closedateFrom,
    closedateTo: closeRange.to || def.closedateTo,
    datePayFrom: payRange.from,
    datePayTo: payRange.to,
  };
  logDebug('[filters] parseFromUrl ->', out);
  return out;
}

/**
 * Сериализация фильтров в URLSearchParams.
 */
export function serializeToUrl(filters) {
  const sp = new URLSearchParams();
  if (Array.isArray(filters.assignedById)) {
    for (const id of filters.assignedById) {
      if (Number.isFinite(id) && id > 0) sp.append('assignedById', String(id));
    }
  }
  if (filters.closedateFrom) sp.append('closedateFrom', filters.closedateFrom);
  if (filters.closedateTo) sp.append('closedateTo', filters.closedateTo);
  if (filters.datePayFrom) sp.append('datePayFrom', filters.datePayFrom);
  if (filters.datePayTo) sp.append('datePayTo', filters.datePayTo);
  return sp;
}

/**
 * Обновляет URL без перезагрузки страницы.
 */
export function applyToHistory(filters) {
  const qs = serializeToUrl(filters).toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  window.history.replaceState({}, '', url);
  logDebug('[filters] applyToHistory ->', url);
}
