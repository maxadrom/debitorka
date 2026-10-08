'use strict';

// app.js — composition root приложения.
// Единственный модуль, который видит все слои (presentation, application, infrastructure).
// Подписывает обработчики, инициализирует bootstrap, маршрутизирует apply→load→render.

import { IS_DEV, logInfo, logDebug } from './modules/env.js';
import { defaultFilters, parseFromUrl, applyToHistory } from './modules/application/filters.js';
import { loadReport } from './modules/application/data-loader.js';
import { collectionRate } from './modules/application/aggregator.js';
import { mountFilters } from './modules/presentation/filters-ui.js';
import { renderReport, mountTabs } from './modules/presentation/table.js';
import { showError, showLoader, showStatus } from './modules/presentation/ui-helpers.js';

async function bootstrap() {
  logInfo(`[app.bootstrap] mode=${IS_DEV ? 'dev' : 'portal'}`);
  showStatus('Инициализация…');

  const filtersForm = document.getElementById('filters');
  const tableEl = document.getElementById('report');
  const paginationEl = document.getElementById('pagination');
  const exportBtn = document.getElementById('export-xlsx');
  const tabsEl = document.getElementById('tabs');

  let initial;
  try {
    initial = parseFromUrl(new URLSearchParams(window.location.search));
  } catch (err) {
    logDebug('[app.bootstrap] parseFromUrl failed, falling back to defaults', err);
    initial = defaultFilters();
  }

  let isLoading = false;
  let report = null; // последний результат loadReport — вкладки переключаются без перезагрузки
  let viewKey = 'clients';

  const render = () => renderReport({ tableEl, paginationEl, exportBtn, report, viewKey });

  async function applyFilters(filters) {
    if (isLoading) {
      logDebug('[app.applyFilters] ignored: load already in progress');
      return;
    }
    isLoading = true;
    filtersUi.setBusy(true);
    showLoader(true);
    try {
      report = await loadReport(filters);
      filtersUi.setAssignees(report.assignees);
      filtersUi.setKpi({ rate: collectionRate(report.totals), paid: report.totals.paid, amount: report.totals.amount });
      render();
      applyToHistory(filters);
    } catch (err) {
      showError('Не удалось загрузить отчёт: ' + err.message, err);
    } finally {
      showLoader(false);
      isLoading = false;
      filtersUi.setBusy(false);
    }
  }

  const filtersUi = mountFilters({
    container: filtersForm,
    initial,
    onSubmit: applyFilters,
  });

  mountTabs({
    container: tabsEl,
    active: viewKey,
    onChange: (key) => {
      viewKey = key;
      logDebug(`[app.tabs] view=${key}`);
      if (report) render();
    },
  });

  // Первичный рендер с initial-фильтрами.
  await applyFilters(initial);
}

// Точка старта: на портале — через BX24.init. В dev сразу: <script type="module">
// отложен, DOM к этому моменту уже разобран.
function run() {
  bootstrap().catch((err) => showError('Не удалось инициализировать приложение: ' + err.message, err));
}

if (typeof window.BX24?.init === 'function') window.BX24.init(run);
else run();
