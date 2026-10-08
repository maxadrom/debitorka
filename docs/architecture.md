# Архитектура

Слоистая архитектура (Presentation → Application → Infrastructure): один линейный поток «фильтр → загрузка → агрегация → рендер → экспорт», ~10 модулей, без лишних абстракций.

## Слои

```
Presentation  (modules/presentation/*)
    ↓
Application   (modules/application/*)
    ↓
Infrastructure (modules/infrastructure/api-client.js)
    ↓
BX24.* / fetch(webhook)
```

Зависимости — строго сверху вниз. Слой не пропускается: `presentation/table.js` НЕ зовёт `infrastructure/api-client.js` напрямую — только через `application/data-loader.js`.

## Модули

| Модуль | Слой | Что делает |
|--------|------|------------|
| `modules/env.js` | infra | Определяет `IS_DEV` (по работоспособному `window.BX24`) и `LOG_VERBOSE` (dev или `?DEBUG=true`); общие логгеры `logInfo` / `logDebug` / `logWarn`; `PORTAL_ORIGIN` — origin портала из webhook-URL (только dev, для ссылки на карточку контакта; в портале `null`) |
| `modules/infrastructure/api-client.js` | infra | `callMethod` → `{result, total}` / `callBatch([[method, params], …])` → массив `{result, total}` (всегда halt). Разводит BX24 vs fetch(webhook) по `IS_DEV`; в dev batch — один POST на `{webhook}batch` (`toBitrixQuery` + `parseBatchResponse`). `withRetry`: до 3 попыток на сеть/503/`QUERY_LIMIT_EXCEEDED`/`OPERATION_TIME_LIMIT`. Содержит security guard, который удаляет `B24_WEBHOOK_URL`, если он просочился в портальный контекст |
| `modules/application/aggregator.js` | app | Чистые функции `aggregate(invoices, today, keyField='contactId')` → `Map<key, {amount, paid, overdue, remain}>` (ключ `contactId` или `assignedById`), `totals`, `collectionRate` (Оплачено / Должен всего, `null` при нулевой сумме). Без I/O |
| `modules/application/data-loader.js` | app | Оркестрация загрузки; общий хелпер пагинации `fetchAll` (первая страница + batch). `item.list` (filter: даты + стадия, без `@assignedById`) → постфильтр по `ufCrmSmartInvoiceDatePay` → список ответственных периода → фильтр по ответственному на клиенте → `contact.list (ID)` через batch ‖ `user.get (FILTER: {ID})` → агрегация по контактам и по сотрудникам |
| `modules/application/filters.js` | app | Состояние фильтров, парсинг URL, сериализация в URL и `history.replaceState`; `toDateKey(date)` — единый форматтер `YYYY-MM-DD` |
| `modules/application/xlsx-export.js` | app | `MONEY_COLUMNS` — денежные колонки отчёта (ключ + заголовок), общие для таблицы и XLSX. `ensureXlsx()` — ленивая подгрузка `vendor/xlsx.full.min.js` при первом экспорте (в `index.html` его нет). Экспорт через глобальный `XLSX`; имя файла и лист задаёт вызывающий (`debt_clients_<дата>.xlsx` / `debt_staff_<дата>.xlsx`, листы «По клиентам» / «По сотрудникам»), по умолчанию `report_<дата выгрузки>.xlsx` |
| `modules/presentation/ui-helpers.js` | UI | Баннер ошибок, индикатор загрузки, открытие слайдера контакта (`BX24.openSlider`; в dev — `window.open` на `PORTAL_ORIGIN`, без webhook — ошибка), `formatMoney`, `assigneeLabel` (ФИО + «(уволен)» — для списка ответственных и вкладки «по сотрудникам»), `escapeHtml` |
| `modules/presentation/filters-ui.js` | UI | Рендер формы фильтров через нативные DOM API + flatpickr. При отправке проверяет диапазоны дат (обе даты срока обязательны, «с» ≤ «по»). Возвращает `{setBusy, setAssignees, setKpi}`: блокировка «Применить»/«Сбросить» на время загрузки, перестроение списка ответственных (с сохранением выбора), KPI «% сбора дебиторки» вверху панели |
| `modules/presentation/table.js` | UI | Вкладки «Дебиторка по клиентам» / «Дебиторка по сотрудникам» (`mountTabs`), рендер таблицы активной вкладки (`renderReport({..., report, viewKey})`), сортировка (мышь и клавиатура: Tab + Enter/Space, `aria-sort`; строки пересортировываются только при смене сортировки), пагинация, строка «Итого», кнопка XLSX (активная вкладка, строки в текущей сортировке; перед экспортом `await ensureXlsx()`; строки снимаются в момент клика, повторный клик во время загрузки игнорируется; кнопка выключена, пока нет отчёта) |
| `app.js` | composition root | Подключает все слои; старт через `BX24.init`, в dev — сразу (module-скрипт отложен, DOM уже разобран) |

## Поток данных

1. **`bootstrap()`** в `app.js`:
   - Парсит фильтры из URL (или дефолт = текущий месяц).
   - Монтирует форму фильтров (список ответственных пуст — только «Любой» — до первой загрузки) и вкладки (`mountTabs`, по умолчанию «по клиентам»).
   - Запускает первичный `applyFilters(initial)`.
2. **`applyFilters(filters)`**:
   - Флаг `isLoading`: повторный вызов во время загрузки игнорируется; кнопки формы заблокированы (`setBusy`).
   - Показывает индикатор загрузки.
   - `loadReport(filters)` → `{byContact, byAssignee, contacts, users, assignees, totals}`; результат кешируется в `app.js`.
   - `setAssignees(report.assignees)` — перестраивает список ответственных; `setKpi(...)` — «% сбора дебиторки» через `collectionRate(totals)`.
   - `renderReport({tableEl, ..., report, viewKey})` рисует активную вкладку + сбрасывает page=1, sort=name asc.
   - `applyToHistory(filters)` обновляет URL без перезагрузки — только здесь, после успешной загрузки.
   - Переключение вкладки — `renderReport` по кешированному `report`, без REST-запросов; вкладка в URL не пишется.
3. **`loadReport`** (в `data-loader.js`):
   - `item.list` с фильтром `{>=closedate, <=closedate, !=stageId:DT31_5:D}` — первая страница + остальные через `callBatch` (пачки до 50 команд). `@assignedById` не отправляется: для списка ответственных нужны все счета периода.
   - Один проход фильтра по счетам периода:
     - постфильтр по `ufCrmSmartInvoiceDatePay`, если задан `datePayFrom`/`datePayTo`;
     - отбрасывание счетов с `contactId == null`.
   - Список ответственных = `assignedById` счетов периода (без учёта выбора) + выбранные из фильтра; затем фильтр по выбранным ответственным на клиенте. Пустой `assignedById` → ключ `0` («Без ответственного»).
   - Ошибки шагов оборачиваются как `data-loader: <invoices|contacts-by-id|users-by-id> failed: …`.
   - Параллельно: `contact.list (ID:[...])` — команды по 50 ID в одном `callBatch` (до 2 500 контактов на batch) — ФИО контактов; `user.get (FILTER: {ID:[...]})` — ФИО и `ACTIVE` ответственных, включая уволенных.
   - `aggregate(invoices, today)` → `byContact`, `aggregate(invoices, today, 'assignedById')` → `byAssignee` (одни и те же счета, «Итого» совпадают) + `totals(byContact)`.

## Безопасность

- **`B24_WEBHOOK_URL` — только dev.** Никогда не попадает в ZIP благодаря `.gitignore` + blacklist в `pack.mjs` + sanity-check.
- **Security guard в `api-client.js`** удаляет `window.B24_WEBHOOK_URL`, если он каким-то образом оказался в портале (например, забыли удалить `dev-config.local.js` перед сборкой). Это последняя линия обороны после whitelist/blacklist.
- **ФИО контакта** рендерится через `textContent`, а не `innerHTML`. CRM может прислать что угодно — не доверяем.
- **Никаких внешних CDN на проде.** vendor лежит локально в `vendor/`, копируется в ZIP.

## Тестируемость

- `aggregator.js` — чистая функция, тестируется юнит-тестами без моков (`tests/aggregator.test.js`).
- `data-loader.js` — принимает `apiClient` параметром (`loadReport(filters, apiClient = defaultApiClient)`). Тесты подменяют через DI без import-magic (`tests/data-loader.test.js`).
- `api-client.js` — браузерный модуль; тесты (`tests/api-client.test.js`) ставят мок `window.BX24` до импорта (портальный режим) и проверяют чистые хелперы `toBitrixQuery`, `parseBatchResponse`, `withRetry`.
- `filters.js` — `tests/filters.test.js` (дефолты, сериализация в URL и обратно).

## Антипаттерны (не делать)

- ❌ Прямой вызов `BX24.callMethod` из `presentation/*`.
- ❌ Импорт `infrastructure/*` из `presentation/*`.
- ❌ Глобальные переменные состояния (`window.appState`).
- ❌ Логирование `params`, `WEBHOOK_URL`, токенов.
- ❌ `innerHTML` с пользовательскими данными (использовать `textContent` или `escapeHtml`).
- ❌ Правки в файлах `vendor/*`. Vendored-библиотеки заменяются целиком при обновлении версии.
