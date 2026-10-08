'use strict';

// modules/application/xlsx-export.js
// Экспорт отчёта в XLSX через глобальный XLSX (vendor/xlsx.full.min.js, грузится лениво — ensureXlsx).
//
// Контракт:
//   exportReport({ rows, totals, nameHeader?, sheetName?, filename? })
// rows: Array<{name, amount, paid, overdue, remain}> (все строки отчёта, не только страница)
// totals: {amount, paid, overdue, remain}
// nameHeader: заголовок первой колонки (по умолчанию 'ФИО')
// filename: по умолчанию 'report_YYYY-MM-DD.xlsx' на дату выгрузки

import { logInfo } from '../env.js';
import { toDateKey } from './filters.js';

// Денежные колонки отчёта — общие для таблицы (table.js) и XLSX.
export const MONEY_COLUMNS = [
  { key: 'amount', label: 'Должен всего' },
  { key: 'paid', label: 'Оплачено' },
  { key: 'overdue', label: 'Просрочено' },
  { key: 'remain', label: 'Остаток к оплате' },
];
const MONEY_KEYS = MONEY_COLUMNS.map((c) => c.key);

const XLSX_SRC = 'vendor/xlsx.full.min.js';
let xlsxLoading = null;

// SheetJS (~1 МБ) нужен только для экспорта — подгружаем при первом клике, а не при старте.
export function ensureXlsx() {
  if (window.XLSX) return Promise.resolve();
  xlsxLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = XLSX_SRC;
    script.onload = () => resolve();
    script.onerror = () => {
      xlsxLoading = null; // даём повторить при следующем клике
      reject(new Error(`xlsx-export: failed to load ${XLSX_SRC}`));
    };
    document.head.appendChild(script);
  });
  return xlsxLoading;
}

export function defaultFilename(prefix = 'report') {
  return `${prefix}_${toDateKey(new Date())}.xlsx`;
}

export function exportReport({ rows, totals, nameHeader = 'ФИО', sheetName = 'Отчёт', filename = defaultFilename() }) {
  const XLSX = typeof window !== 'undefined' ? window.XLSX : undefined;
  if (!XLSX) {
    throw new Error('xlsx-export: XLSX global not loaded (vendor/xlsx.full.min.js)');
  }
  // Числа в AOA aoa_to_sheet сам типизирует как 'n'.
  const data = [
    [nameHeader, ...MONEY_COLUMNS.map((c) => c.label)],
    ...rows.map((r) => [r.name, ...MONEY_KEYS.map((k) => r[k])]),
    ['Итого', ...MONEY_KEYS.map((k) => totals[k])],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  // Ширины колонок (примерные, без стилей — они в community-версии не сохраняются).
  ws['!cols'] = [{ wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
  logInfo(`[xlsx-export] saved as ${filename} rows=${rows.length}`);
}
