'use strict';

// modules/presentation/ui-helpers.js
// Общие хелперы UI: баннер ошибок, индикатор загрузки, открытие слайдера контакта,
// форматирование денег, экранирование HTML.
//
// Не импортирует api-client напрямую: открытие слайдера через window.BX24.openPath (если есть)
// или window.open (в dev). Это единственное место, где presentation касается окружения.

import { logDebug, PORTAL_ORIGIN } from '../env.js';

const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

function getStatusEl() {
  return document.getElementById('status');
}

export function showError(message, details) {
  const el = getStatusEl();
  if (el) {
    el.textContent = message;
    el.classList.add('error');
    el.classList.remove('loading');
  }
  // details печатаем отдельным аргументом, чтобы DevTools показал raw-объект.
  console.error('[ui]', message, details);
}

export function showLoader(visible) {
  const el = getStatusEl();
  if (!el) return;
  if (visible) {
    el.textContent = 'Загрузка отчёта…';
    el.classList.add('loading');
    el.classList.remove('error');
  } else {
    el.classList.remove('loading');
    if (el.textContent === 'Загрузка отчёта…') el.textContent = '';
  }
}

export function showStatus(message) {
  const el = getStatusEl();
  if (!el) return;
  el.textContent = message;
  el.classList.remove('error', 'loading');
}

/**
 * Открывает карточку контакта в слайдере портала (BX24.openPath) или в новой вкладке:
 * в dev, а также если слайдер не открылся (например, в мобильном приложении).
 * Метода BX24.openSlider в SDK нет — только openPath.
 * @param {number} contactId
 */
export function openContactSlider(contactId) {
  const path = `/crm/contact/details/${contactId}/`;
  const bx = window.BX24;
  if (typeof bx?.openPath === 'function') {
    logDebug(`[ui.openContactSlider] id=${contactId} mode=portal`);
    bx.openPath(path, (res) => {
      if (res?.result !== 'error') return;
      logDebug(`[ui.openContactSlider] openPath failed: ${res.errorCode}`);
      const domain = typeof bx.getDomain === 'function' ? bx.getDomain() : null;
      if (domain) window.open(`https://${domain}${path}`, '_blank', 'noopener,noreferrer');
      else showError('Не удалось открыть карточку контакта.');
    });
    return;
  }
  logDebug(`[ui.openContactSlider] id=${contactId} mode=dev`);
  if (!PORTAL_ORIGIN) {
    showError('Не удалось открыть карточку контакта: адрес портала не задан (нет webhook в dev-config.local.js).');
    return;
  }
  window.open(`${PORTAL_ORIGIN}${path}`, '_blank', 'noopener,noreferrer');
}

/**
 * Экранирование HTML для безопасной вставки в атрибуты (textContent остаётся предпочтительным).
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Форматирует число в валюту RUB по русской локали.
 * @param {number} value
 */
export function formatMoney(value) {
  return moneyFormatter.format(value);
}

/**
 * Подпись сотрудника: ФИО, у уволенного — с пометкой «(уволен)».
 * @param {{fio:string, active:boolean}} user
 */
export function assigneeLabel(user) {
  return user.active ? user.fio : `${user.fio} (уволен)`;
}
