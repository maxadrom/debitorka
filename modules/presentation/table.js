'use strict';

// modules/presentation/table.js
// Рендер таблицы отчёта: вкладки «по клиентам» / «по сотрудникам», сортировка,
// пагинация, строка «Итого», экспорт XLSX.
//
// state (sort + currentPage) хранится в замыкании модуля и сбрасывается
// при каждом вызове renderReport (новые фильтры или смена вкладки → page=1, sort=name asc).

import { exportReport, defaultFilename, ensureXlsx, MONEY_COLUMNS } from '../application/xlsx-export.js';
import { openContactSlider, formatMoney, showError, assigneeLabel } from './ui-helpers.js';
import { logDebug } from '../env.js';

const PAGE_SIZE = 100;
const NAME_COLUMN = { key: 'name', kind: 'string' };
const COLUMNS = [NAME_COLUMN, ...MONEY_COLUMNS.map((c) => ({ ...c, kind: 'number' }))];
const MONEY_KEYS = MONEY_COLUMNS.map((c) => c.key);

const collator = new Intl.Collator('ru', { sensitivity: 'base' });

// Вкладки отчёта. rows(report) строит строки из результата loadReport.
const VIEWS = {
  clients: {
    tabLabel: 'Дебиторка по клиентам',
    nameLabel: 'ФИО',
    sheetName: 'По клиентам',
    filePrefix: 'debt_clients',
    rows: (report) => [...report.byContact].map(([id, agg]) => {
      const contact = report.contacts.get(id);
      return { contactId: id, name: contact && contact.fio ? contact.fio : `Контакт #${id}`, ...agg };
    }),
  },
  staff: {
    tabLabel: 'Дебиторка по сотрудникам',
    nameLabel: 'Сотрудник',
    sheetName: 'По сотрудникам',
    filePrefix: 'debt_staff',
    rows: (report) => [...report.byAssignee].map(([id, agg]) => ({
      name: id === 0 ? 'Без ответственного' : assigneeLabel(report.users.get(id)),
      ...agg,
    })),
  },
};

let exporting = false;
let state = null; // { view, rows (отсортированы), totals, sort: {col, dir}, currentPage, tableEl, paginationEl }

function sortRows() {
  const { col, dir } = state.sort;
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = col === 'name'
    ? (a, b) => collator.compare(a.name, b.name)
    : (a, b) => a[col] - b[col];
  state.rows.sort((a, b) => sign * cmp(a, b));
}

function renderHead(tableEl) {
  const tr = document.createElement('tr');
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col === NAME_COLUMN ? state.view.nameLabel : col.label;
    th.dataset.col = col.key;
    th.className = `col-${col.key} sortable`;
    if (col.kind === 'number') th.classList.add('align-right');
    th.tabIndex = 0;
    const indicator = document.createElement('span');
    indicator.className = 'sort-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    th.appendChild(indicator);
    th.addEventListener('click', () => toggleSort(col));
    th.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); // Space не должен прокручивать страницу
        toggleSort(col);
      }
    });
    tr.appendChild(th);
  }
  tableEl.tHead.replaceChildren(tr);
}

function toggleSort(col) {
  if (state.sort.col === col.key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.col = col.key;
    state.sort.dir = col.kind === 'string' ? 'asc' : 'desc';
  }
  logDebug(`[table.sort] by=${state.sort.col} dir=${state.sort.dir}`);
  sortRows();
  state.currentPage = 1;
  rerender();
}

function updateSortIndicators() {
  for (const th of state.tableEl.tHead.querySelectorAll('th')) {
    const active = th.dataset.col === state.sort.col;
    const asc = state.sort.dir === 'asc';
    th.querySelector('.sort-indicator').textContent = active ? (asc ? ' ▲' : ' ▼') : '';
    th.setAttribute('aria-sort', active ? (asc ? 'ascending' : 'descending') : 'none');
  }
}

function moneyCell(value, className) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = formatMoney(value);
  return td;
}

function renderTbody() {
  const tbody = state.tableEl.tBodies[0];

  if (state.rows.length === 0) {
    const td = document.createElement('td');
    td.colSpan = COLUMNS.length;
    td.className = 'empty-state';
    td.textContent = 'Нет данных за выбранный период';
    const tr = document.createElement('tr');
    tr.appendChild(td);
    tbody.replaceChildren(tr);
    return;
  }

  const start = (state.currentPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (const r of state.rows.slice(start, start + PAGE_SIZE)) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'col-name';
    tdName.title = r.name;
    if (r.contactId != null) {
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.contactId = String(r.contactId);
      a.textContent = r.name; // textContent безопасен для имени контакта
      a.setAttribute('aria-label', `Открыть карточку контакта ${r.name}`);
      tdName.appendChild(a);
    } else {
      tdName.textContent = r.name;
    }
    tr.appendChild(tdName);

    for (const key of MONEY_KEYS) {
      const td = moneyCell(r[key], `col-${key} align-right`);
      if (key === 'overdue' && r[key] > 0) td.classList.add('cell-overdue');
      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  tbody.replaceChildren(fragment);
}

function renderTfoot(tableEl, totals) {
  const tr = document.createElement('tr');
  const tdLabel = document.createElement('td');
  tdLabel.className = 'col-name';
  tdLabel.textContent = 'Итого';
  tr.appendChild(tdLabel);
  for (const key of MONEY_KEYS) {
    tr.appendChild(moneyCell(totals[key], `col-${key} align-right`));
  }
  tableEl.tFoot.replaceChildren(tr);
}

function pageButton(text, disabled, delta) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.disabled = disabled;
  btn.addEventListener('click', () => {
    state.currentPage += delta;
    logDebug(`[table.pagination] page=${state.currentPage}`);
    rerender();
    state.tableEl.scrollIntoView({ block: 'start' });
  });
  return btn;
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.rows.length / PAGE_SIZE));
  const indicator = document.createElement('span');
  indicator.className = 'page-indicator';
  indicator.textContent = `${state.currentPage} из ${totalPages}`;
  state.paginationEl.replaceChildren(
    pageButton('← Назад', state.currentPage <= 1, -1),
    indicator,
    pageButton('Вперёд →', state.currentPage >= totalPages, +1),
  );
}

function rerender() {
  renderTbody();
  renderPagination();
  updateSortIndicators();
}

/**
 * Главный рендер вкладки viewKey ('clients' | 'staff') по результату loadReport.
 */
export function renderReport({ tableEl, paginationEl, exportBtn, report, viewKey }) {
  const view = VIEWS[viewKey] ?? VIEWS.clients;
  const { totals } = report;
  // ВАЖНО: сбрасываем page и sort на каждый renderReport — это новый снимок данных.
  state = {
    view,
    rows: view.rows(report),
    totals,
    sort: { col: 'name', dir: 'asc' },
    currentPage: 1,
    tableEl,
    paginationEl,
  };
  sortRows();

  renderHead(tableEl);
  renderTfoot(tableEl, totals);

  // Делегированный обработчик клика на ФИО → openContactSlider.
  const tbody = tableEl.tBodies[0];
  if (!tbody.dataset.delegated) {
    tbody.addEventListener('click', (event) => {
      const a = event.target.closest('a[data-contact-id]');
      if (!a) return;
      event.preventDefault();
      openContactSlider(Number(a.dataset.contactId));
    });
    tbody.dataset.delegated = '1';
  }

  rerender();

  exportBtn.disabled = false;
  exportBtn.onclick = async () => {
    if (exporting) return; // повторный клик, пока грузится SheetJS
    // Снимок до await: за время первой загрузки SheetJS можно переключить вкладку
    // или пересортировать — выгружаем то, что было на экране в момент клика.
    const job = {
      rows: state.rows.slice(),
      totals: state.totals,
      nameHeader: view.nameLabel,
      sheetName: view.sheetName,
      filename: defaultFilename(view.filePrefix),
    };
    exporting = true;
    try {
      await ensureXlsx();
      exportReport(job);
    } catch (err) {
      showError('Не удалось экспортировать XLSX: ' + err.message, err);
    } finally {
      exporting = false;
    }
  };
}

/**
 * Вкладки над таблицей. onChange(viewKey) вызывается при переключении.
 */
export function mountTabs({ container, active, onChange }) {
  const buttons = Object.entries(VIEWS).map(([key, view]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.view = key;
    btn.textContent = view.tabLabel;
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-selected') === 'true') return;
      setActive(key);
      onChange(key);
    });
    return btn;
  });
  function setActive(key) {
    for (const b of buttons) b.setAttribute('aria-selected', b.dataset.view === key ? 'true' : 'false');
  }
  container.replaceChildren(...buttons);
  setActive(active);
}
