'use strict';

// modules/presentation/filters-ui.js
// Рендер формы фильтров и сбор состояния для отправки в onSubmit(filters).
//
// Использует глобальный flatpickr (vendor) с RU-локалью (vendor/flatpickr.l10n.ru.js
// сам регистрирует window.flatpickr.l10ns.ru при загрузке).

import { defaultFilters } from '../application/filters.js';
import { showError, formatMoney, assigneeLabel } from './ui-helpers.js';
import { logInfo, logDebug } from '../env.js';

const ANY_VALUE = '__any__';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
  }
  node.append(...children.filter(Boolean));
  return node;
}

function dateInput(id, value) {
  return el('input', { type: 'text', id, placeholder: 'дд.мм.гггг', value: value || '' });
}

// Колонка «<title>: с … по …» из двух полей даты.
function dateRangeCol(title, fromInput, toInput) {
  const field = (input, label) => el('label', { class: 'filter-field', for: input.id },
    el('span', { class: 'filter-label', text: label }), input);
  return el('div', { class: 'filter-col' },
    el('span', { class: 'filter-col-title', text: title }),
    el('div', { class: 'filter-row' }, field(fromInput, 'с'), field(toInput, 'по'))
  );
}

/**
 * @param {{
 *   container: HTMLFormElement,
 *   initial: ReturnType<typeof defaultFilters>,
 *   onSubmit: (filters) => void,
 * }} params
 * @returns {{
 *   setBusy: (busy: boolean) => void,
 *   setAssignees: (list: Array<{id:number, fio:string, active:boolean}>) => void,
 *   setKpi: (kpi: {rate:number|null, paid:number, amount:number}|null) => void,
 * }}
 */
export function mountFilters({ container, initial, onSubmit }) {
  container.replaceChildren();

  // Multi-select «Ответственный» + опция «Любой» как способ сброса.
  // Список — ответственные счетов за выбранный период; приходит после каждой
  // загрузки отчёта через setAssignees (до первой загрузки — только «Любой»).
  // Логика «Любой»: если выбрано — фильтр по ответственному не применяется
  // (readState вернёт пустой массив). При выборе любого пользователя «Любой»
  // автоматически снимается; при выборе «Любой» — снимаются все пользователи.
  const assigneeSelect = el('select', {
    id: 'filter-assignee',
    name: 'assignedById',
    multiple: 'multiple',
  });
  const anyOption = el('option', { value: ANY_VALUE, text: '— Любой —' });

  const selectedValues = () => new Set(Array.from(assigneeSelect.selectedOptions, (o) => o.value));
  const selectedIds = () => Array.from(assigneeSelect.selectedOptions, (o) => Number(o.value))
    .filter((n) => Number.isFinite(n) && n > 0);
  let prevSelected;
  // Выбор из URL держим, пока не пришёл первый список.
  let pendingIds = initial.assignedById || [];

  // Перестраивает список пользователей, сохраняя выбор ids; пустой выбор → «Любой».
  function fillAssignees(list, ids) {
    const keep = new Set(ids);
    const options = list.map((a) => {
      const opt = el('option', { value: String(a.id), text: assigneeLabel(a) });
      opt.selected = keep.has(a.id);
      return opt;
    });
    assigneeSelect.replaceChildren(anyOption, ...options);
    assigneeSelect.size = Math.min(9, Math.max(4, list.length + 1));
    anyOption.selected = !options.some((o) => o.selected);
    prevSelected = selectedValues();
  }
  fillAssignees([], []);

  function selectAny() {
    for (const o of assigneeSelect.options) o.selected = o === anyOption;
  }

  // Взаимное исключение «Любой» и конкретных пользователей. Решаем по тому,
  // что именно добавилось к выбору с прошлого change:
  //   добавился «Любой» → снимаем всех пользователей;
  //   добавился пользователь → снимаем «Любой»;
  //   выбор пуст → возвращаем «Любой».
  assigneeSelect.addEventListener('change', () => {
    const added = [...selectedValues()].filter((v) => !prevSelected.has(v));
    if (added.includes(ANY_VALUE)) {
      selectAny();
    } else if (added.length > 0) {
      anyOption.selected = false;
    }
    if (assigneeSelect.selectedOptions.length === 0) anyOption.selected = true;
    prevSelected = selectedValues();
    pendingIds = null;
  });

  const assigneeCol = el('div', { class: 'filter-col' },
    el('label', { class: 'filter-field', for: 'filter-assignee' },
      el('span', { class: 'filter-col-title', text: 'Ответственный за счёт' }),
      assigneeSelect
    ),
    el('span', { class: 'filter-hint', text: 'Только те, у кого есть счета за период' })
  );

  // Срок оплаты (closedate) и дата оплаты (ufCrmSmartInvoiceDatePay), значения — ISO.
  const closeFrom = dateInput('filter-close-from', initial.closedateFrom);
  const closeTo = dateInput('filter-close-to', initial.closedateTo);
  const payFrom = dateInput('filter-pay-from', initial.datePayFrom);
  const payTo = dateInput('filter-pay-to', initial.datePayTo);

  const submitBtn = el('button', { type: 'submit', class: 'btn-primary', text: 'Применить' });
  const resetBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Сбросить' });

  // «% сбора дебиторки» по текущему фильтру (Оплачено / Должен всего).
  const kpiValue = el('span', { class: 'kpi-value', text: '—' });
  const kpiNote = el('span', { class: 'kpi-note' });
  const kpiBlock = el('div', { class: 'kpi', role: 'status' },
    el('span', { class: 'filter-col-title', text: '% сбора дебиторки' }),
    kpiValue,
    kpiNote
  );

  container.append(
    kpiBlock,
    assigneeCol,
    dateRangeCol('Срок оплаты', closeFrom, closeTo),
    dateRangeCol('Дата оплаты', payFrom, payTo),
    el('div', { class: 'filter-buttons' }, submitBtn, resetBtn)
  );

  // flatpickr — обёртка над инпутами (если глобал доступен).
  const fp = window.flatpickr;
  if (fp) {
    const opts = {
      locale: (fp.l10ns && fp.l10ns.ru) || 'ru',
      dateFormat: 'Y-m-d', // внутри храним ISO
      altInput: true,
      altFormat: 'd.m.Y',
      allowInput: true,
    };
    for (const input of [closeFrom, closeTo, payFrom, payTo]) fp(input, opts);
  } else {
    console.warn('[filters-ui] window.flatpickr is undefined — date pickers will fall back to plain text inputs');
  }

  function setDate(input, value) {
    if (input._flatpickr) {
      if (value) input._flatpickr.setDate(value, false);
      else input._flatpickr.clear();
    }
    input.value = value || '';
  }

  function readState() {
    return {
      assignedById: pendingIds ?? selectedIds(),
      closedateFrom: closeFrom.value || null,
      closedateTo: closeTo.value || null,
      datePayFrom: payFrom.value || null,
      datePayTo: payTo.value || null,
    };
  }

  // container (#filters) — сам <form>: слушаем submit, иначе Enter в поле даты
  // делал нативный GET-переход вместо загрузки отчёта.
  container.addEventListener('submit', (event) => {
    event.preventDefault();
    const state = readState();
    if (!state.closedateFrom || !state.closedateTo) {
      showError('Укажите диапазон «Срок оплаты» (обе даты обязательны).');
      return;
    }
    // Даты в ISO (YYYY-MM-DD) — строки сравниваются как даты.
    if (state.closedateFrom > state.closedateTo) {
      showError('«Срок оплаты»: дата «с» позже даты «по».');
      return;
    }
    if (state.datePayFrom && state.datePayTo && state.datePayFrom > state.datePayTo) {
      showError('«Дата оплаты»: дата «с» позже даты «по».');
      return;
    }
    logDebug('[filters-ui] submit ->', state);
    onSubmit(state);
  });

  resetBtn.addEventListener('click', () => {
    const def = defaultFilters();
    pendingIds = null;
    selectAny();
    prevSelected = selectedValues();
    setDate(closeFrom, def.closedateFrom);
    setDate(closeTo, def.closedateTo);
    setDate(payFrom, '');
    setDate(payTo, '');
    logDebug('[filters-ui] reset ->', def);
    onSubmit(def);
  });

  logInfo('[filters-ui] mounted');

  // Блокировка кнопок на время загрузки отчёта (защита от повторного «Применить»).
  function setBusy(busy) {
    submitBtn.disabled = busy;
    resetBtn.disabled = busy;
    container.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function setAssignees(list) {
    fillAssignees(list, pendingIds ?? selectedIds());
    pendingIds = null;
  }

  const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function setKpi(kpi) {
    if (!kpi || kpi.rate === null) {
      kpiValue.textContent = '—';
      kpiNote.textContent = kpi ? 'Нет счетов к оплате' : '';
      return;
    }
    kpiValue.textContent = percent.format(kpi.rate);
    kpiNote.textContent = `Оплачено ${formatMoney(kpi.paid)} из ${formatMoney(kpi.amount)}`;
  }

  return { setBusy, setAssignees, setKpi };
}
