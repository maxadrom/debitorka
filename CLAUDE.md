# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

Локальное приложение Битрикс24 (тип «Локальное приложение», ZIP без бэкенда) для портала `<portal>.bitrix24.ru`: отчёт «Дебиторка» по умным счетам (Smart Invoice 2.0, `entityTypeId=31`) — две вкладки: по клиентам (контактам) и по сотрудникам (ответственным за счёт), плюс KPI «% сбора дебиторки». Закрывает дыру BI-конструктора — там нельзя задать одновременно «срок оплаты от/до» и «дату оплаты от/до».

Vanilla JS (ES2020, ES Modules), без сборщика и фреймворков. Vendored: SheetJS (XLSX), flatpickr + RU-локаль. Node нужен только для тестов и упаковки.

## Команды

```bash
npm test                                   # все тесты: node --test tests/*.test.js
node --test tests/aggregator.test.js       # один файл
node --test --test-name-pattern="DT31_5:S" tests/aggregator.test.js   # тесты по подстроке имени
npm run pack                               # → dist/fin25_otch.zip (whitelist + sanity-check + лимит 500 KB)
npm run dev:setup                          # .env → dev-config.local.js (window.B24_WEBHOOK_URL)
# dev-сервер: .claude/launch.json → «static» (python без кеша, порт 8081) → http://localhost:8081/index.html
# простой `python3 -m http.server` тоже работает, но кеширует ES-модули — после правок нужен hard reload
```

После `npm run pack` проверять `unzip -l dist/fin25_otch.zip`: не должно быть `.env`, `dev-config*`, `tests/`, `*.md`, `package.json`.

## Архитектура

Слои строго сверху вниз, слой не пропускается:

```
app.js (composition root) → modules/presentation/* → modules/application/* → modules/infrastructure/api-client.js → BX24.* | fetch(webhook)
```

- **Два режима работы, переключатель — только работоспособный `window.BX24`** (`modules/env.js`: `typeof window.BX24.callMethod === 'function'`). Есть → портал, `BX24.callMethod/callBatch`. Нет → dev: POST JSON на `window.B24_WEBHOOK_URL` (batch — один POST на `{webhook}batch`) из `dev-config.local.js` (подключается в `index.html` до `app.js`; в ZIP его нет → 404 → портальный режим). `?DEBUG=true` влияет только на логирование, режим не переключает. `api-client.js` удаляет `B24_WEBHOOK_URL`, если тот оказался в портальном контексте.
- **REST-вызовы — только через `api-client.js`** (`BX24.callMethod/callBatch` или `fetch`). Вне него `BX24` трогают лишь `app.js` (`BX24.init`) и `ui-helpers.openContactSlider` (`BX24.openSlider`, в dev — `window.open`).
- **`data-loader.js`** — оркестрация: `crm.item.list` (фильтр `>=closedate`, `<=closedate`, `!=stageId: DT31_5:D`; первая страница, остальные — через `callBatch` пачками по 50; `@assignedById` **не** отправляется) → постфильтр по `ufCrmSmartInvoiceDatePay` на клиенте → отбрасывание счетов без `contactId` → список ответственных периода → фильтр по ответственному на клиенте → `crm.contact.list` по `ID` через `callBatch` (50 ID в команде) ‖ `user.get` с `FILTER: {ID: [...]}` (включая уволенных) → агрегация по контактам и по сотрудникам. Контракт: `loadReport(filters) → { byContact, byAssignee, contacts, users: Map<id,{fio,active}>, assignees: Array<{id,fio,active}>, totals }`. Принимает `apiClient` параметром (DI) — тесты подменяют его моком, без import-магии.
- **`aggregator.js`** — чистые функции `aggregate(invoices, today, keyField='contactId') → Map<key, {amount, paid, overdue, remain}>` (ключ `contactId` или `assignedById`), `totals`, `collectionRate(totals)` (Оплачено / Должен всего, `null` при нулевой сумме), без I/O и DOM. Вся арифметика отчёта — только здесь, не в `table.js`.
- **`filters.js`** — состояние фильтров, зеркалится в URL через `history.replaceState`. По умолчанию — текущий месяц по `closedate`.
- **`table.js`** — вкладки «Дебиторка по клиентам» / «Дебиторка по сотрудникам» (фильтры общие; переключение без перезагрузки — по последнему результату `loadReport`; вкладка в URL не хранится). 100 строк/страница, сортировка по имени (ru) по умолчанию, строка «Итого» по **всем** отфильтрованным строкам (на обеих вкладках совпадает). XLSX выгружает активную вкладку: все строки + «Итого» (`debt_clients_YYYY-MM-DD.xlsx` / `debt_staff_YYYY-MM-DD.xlsx`).
- **`filters-ui.js`** — форма фильтров и KPI «% сбора дебиторки» вверху панели (`setKpi`); список ответственных обновляется после каждой загрузки отчёта (`setAssignees`).

## Бизнес-правила (не менять без явного решения пользователя)

- `is_paid := stageId === 'DT31_5:P'` (воронка одна — `categoryId=5` «Общее»). Любая другая стадия (`DT31_5:N`, `DT31_5:S`, все `DT31_5:UC_*`, включая «Замороженные платежи» — просрочка у них только по дате) — в работе → «Остаток», а при `closedate < today` ещё и «Просрочено». `DT31_5:D` («Не оплачен», финальная неуспешная стадия) не учитываем — отсекается серверным фильтром (решение пользователя).
- Фильтр «Ответственный» — ответственный **за счёт** (`assignedById` в `crm.item.list`), не за контакт. Применяется на клиенте. Список в дропдауне — только ответственные счетов за период (после фильтров по `closedate` и дате оплаты, счета с `contactId`), ФИО — `user.get` по ID, уволенные с пометкой «(уволен)» (на портале 20 из 23 владельцев счетов уволены). Выбранные из URL без счетов остаются в списке, чтобы выбор можно было снять. Счёт без ответственного — ключ `0`, «Без ответственного».
- Вкладка «по сотрудникам» считается по тем же счетам (с `contactId`), что и «по клиентам», — «Итого» совпадают. Счета без контакта на портале удалены (2026-10-08), код их по-прежнему отбрасывает.
- `opportunity = 0` — норма: при переплате сумму счёта переносят в оплачиваемый счёт, обнулённый остаётся.
- «% сбора дебиторки» = Оплачено / Должен всего по текущему фильтру; при нулевой сумме — «—». Формулу не менять, колонку «% сбора» в строках не добавлять, вкладку в URL не хранить (решения пользователя).
- Фильтр «дата оплаты»: у оплаченного (`DT31_5:P`) счёта без `ufCrmSmartInvoiceDatePay` датой оплаты считается `closedate` (решение пользователя 2026-10-08); неоплаченный без даты оплаты отсекается при любом непустом диапазоне.

## Подводные камни REST Битрикса

- Имена полей — строго как в `crm.item.fields`: для `crm.item.list` camelCase (`closedate`, не `closeDate`; `assignedById`, `ufCrmSmartInvoiceDatePay`), для `crm.contact.list` UPPER_SNAKE (`ASSIGNED_BY_ID`, `LAST_NAME`).
- Используемые методы: `crm.item.list`, `crm.contact.list`, `user.get`, классический `batch` (≤50 команд). Batch v3 (`/rest/api/.../batch`) CRM-методы не поддерживает (проверено 2026-10-05). В dev `callBatch` — один POST на `{webhook}batch`, команды сериализует `toBitrixQuery`; операторы фильтра внутри batch-команд работают.
- `callMethod`/`callBatch` повторяются (`withRetry`, 3 попытки) только на сеть/503/`QUERY_LIMIT_EXCEEDED`/`OPERATION_TIME_LIMIT`.
- Прямой запрос к webhook с операторами фильтра (`>=closedate`, `!=stageId`) работает **только** как POST с `Content-Type: application/json`. GET и form-urlencoded молча игнорируют фильтр.
- Портал маленький: ~1 740 счетов всего, за типичный месяц ~5–15 (данные в основном 2021–2025). Для живых проверок удобнее брать год, а не месяц — иначе выборка почти пустая.

## Конвенции

- Файлы `kebab-case`, константы `SCREAMING_SNAKE_CASE`, только именованные экспорты.
- Логи с префиксом модуля (`[data-loader] ...`). `console.log`/`logDebug` — только под `LOG_VERBOSE`. Никогда не логировать webhook-URL, токены и полные `params`.
- Пользовательские данные (ФИО из CRM) — только через `textContent` или `escapeHtml`, без `innerHTML`.
- Ошибки: `infrastructure` бросает `Error` с контекстом (`api-client: <method> failed: ...`) → `presentation` показывает через `ui-helpers.showError`. Никаких `alert()`.
- `vendor/*` не редактировать — только заменять целиком (версии в `vendor/VERSIONS.txt`).
- Никаких внешних CDN, кроме `BX24.js` с `api.bitrix24.com`.

## Секреты

`B24_WEBHOOK_URL` живёт в `.env` и `dev-config.local.js` (оба в `.gitignore` и в blacklist `pack.mjs`, который ещё и грепает архив на webhook-паттерн). Не печатать его в чат, логи, коммиты; скрипты в `scripts/` читают его из `.env`.

## Рабочий процесс

- Документы: `docs/spec.md` (спецификация), `docs/research.md` (подтверждённые поля API, фильтры, открытые вопросы), `docs/api.md`, `docs/architecture.md`, `docs/development.md`, `docs/install.md`.
- `NEXT.md` — где остановились и что дальше.
- Порядок: план документом → выполнение в новой сессии → выкатка → обновление документации. «Актуализация» — это обновить статус и документы, а не писать код.
- Загрузку ZIP на портал делает пользователь сам (`docs/install.md`); агент только собирает ZIP.
- Git: не коммитить и не создавать ветки без явной просьбы. Каждую shell-команду — отдельным шагом, без цепочек `&&`.
