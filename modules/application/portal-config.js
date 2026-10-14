'use strict';

// modules/application/portal-config.js
// ЕДИНСТВЕННОЕ место, где живут значения конкретного портала.
// При переносе отчёта на другой портал меняется только этот файл — код, вёрстка и тесты
// берут значения отсюда. Как узнать значения на своём портале — docs/adapt-to-portal.md
// (или `npm run portal:probe`, он же проверит текущие значения).

export const PORTAL = {
  // Смарт-счета (Smart Invoice) — у Битрикс24 всегда 31.
  ENTITY_TYPE_INVOICE: 31,

  // Стадия «Оплачен» (SEMANTICS = S) воронки счетов. Формат: DT31_<categoryId>:P.
  STAGE_PAID: 'DT31_5:P',

  // Финальная неуспешная стадия «Не оплачен» (SEMANTICS = F) — в отчёт не входит.
  STAGE_FAILED: 'DT31_5:D',

  // Поле счёта «Дата оплаты» (date), имя — как в crm.item.fields (camelCase).
  // У оплаченного счёта без этой даты датой оплаты считается срок оплаты (closedate);
  // неоплаченный без даты при непустом фильтре «Дата оплаты» отсекается.
  PAY_DATE_FIELD: 'ufCrmSmartInvoiceDatePay',

  // Код локального приложения и имя архива dist/<APP_CODE>.zip.
  APP_CODE: 'fin25_otch',
};
