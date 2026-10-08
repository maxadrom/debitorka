# AGENTS.md — инструкция для ИИ-агентов

Этот файл для любого ИИ-ассистента (Claude Code, Codex, Cursor, Copilot и т. п.), которому дали этот репозиторий. Прочитай его целиком до первой правки. Подробности — в `docs/`, история решений — в `docs/research.md`, текущий статус — в `NEXT.md`. `CLAUDE.md` — то же самое в сжатом виде для Claude Code; при расхождении верь коду и `docs/`.

## Что это

**Debitorka («Отчёт по счетам»)** — локальное приложение Битрикс24 (тип «Локальное приложение»: ZIP со статикой, без бэкенда). Отчёт «Дебиторка» по умным счетам (Smart Invoice, `entityTypeId=31`):

- две вкладки — по клиентам (контактам) и по сотрудникам (ответственным за счёт);
- колонки: Должен всего / Оплачено / Просрочено / Остаток к оплате + строка «Итого»;
- KPI «% сбора дебиторки» = Оплачено / Должен всего;
- фильтры: срок оплаты (`closedate`) от/до, дата оплаты от/до, ответственный (multi-select);
- экспорт активной вкладки в XLSX.

Зачем: в BI-конструкторе Битрикс24 нельзя одновременно задать «срок оплаты от/до» и «дату оплаты от/до».

Стек: vanilla JS (ES2020, ES Modules), без сборщика и фреймворков. Vendored: SheetJS (XLSX), flatpickr + RU-локаль. Node нужен только для тестов и упаковки.

## Команды

```bash
npm install                 # только devDependency archiver (для упаковки)
npm test                    # node --test tests/*.test.js — без сети, REST замокан
npm run pack                # → dist/fin25_otch.zip (whitelist, проверка на утечку webhook, лимит 500 KB)
npm run dev:setup           # .env → dev-config.local.js (window.B24_WEBHOOK_URL)
```

Локальный запуск: любой статический сервер в корне, например
`python3 -m http.server 8081` → `http://localhost:8081/index.html`.
Обычный `http.server` кеширует ES-модули — после правок делай hard reload (в `.claude/launch.json` есть вариант без кеша).

## Два режима работы

Переключатель — только «рабочий» `window.BX24` (`modules/env.js`: `typeof window.BX24?.callMethod === 'function'`).

| Режим | Когда | Как ходит в REST |
|---|---|---|
| portal | приложение открыто внутри Битрикс24 | `BX24.callMethod` / `BX24.callBatch` от имени пользователя |
| dev | открыто локально (BX24 SDK не инициализировался) | `fetch` POST JSON на входящий вебхук из `dev-config.local.js` |

`?DEBUG=true` включает подробные логи, режим не меняет. Для dev нужен вебхук с правами `crm`, `user`: `.env.example` → `.env` → `npm run dev:setup`.

## Архитектура

Слои строго сверху вниз, слой не пропускается:

```
app.js (composition root)
  → modules/presentation/*   (DOM: filters-ui.js, table.js, ui-helpers.js)
  → modules/application/*    (data-loader.js, aggregator.js, filters.js, xlsx-export.js)
  → modules/infrastructure/api-client.js
  → BX24.* | fetch(webhook)
```

- REST — **только** через `api-client.js` (`callMethod`, `callBatch`, ретраи на сеть/503/лимиты). Вне него `BX24` трогают лишь `app.js` (`BX24.init`) и `ui-helpers.openContactSlider`.
- `data-loader.loadReport(filters, apiClient)` — вся оркестрация; `apiClient` передаётся параметром, тесты подставляют мок.
- `aggregator.js` — вся арифметика отчёта, чистые функции без I/O и DOM. В `table.js` не считать.
- `filters.js` — состояние фильтров ↔ URL (`history.replaceState`).
- `MONEY_COLUMNS` в `xlsx-export.js` — единственное описание денежных колонок (таблица и XLSX берут его оттуда).
- SheetJS (~950 KB) грузится лениво при первом экспорте (`ensureXlsx`), в `index.html` его нет.

Поток данных: `crm.item.list` (серверный фильтр по `closedate` и стадии; первая страница отдельно, остальные — `callBatch` по 50) → клиентский фильтр по дате оплаты и ответственному → `crm.contact.list` по ID ‖ `user.get` по ID (включая уволенных) → `aggregate` по контактам и по сотрудникам.

## Бизнес-правила (не менять без явного решения человека)

- Оплачен ⇔ `stageId === 'DT31_5:P'`. Любая другая стадия — «Остаток», а при `closedate < сегодня` ещё и «Просрочено».
- Стадия `DT31_5:D` («Не оплачен», финальная неуспешная) в отчёт не входит — отсекается фильтром `!=stageId`.
- Ответственный — за **счёт** (`assignedById`), не за контакт; фильтр применяется на клиенте. В списке — только ответственные счетов за период; уволенные с пометкой «(уволен)». Счёт без ответственного — ключ `0`, «Без ответственного».
- Счета без `contactId` отбрасываются; обе вкладки считаются по одним и тем же счетам, «Итого» совпадают.
- Фильтр «Дата оплаты»: у оплаченного счёта без `ufCrmSmartInvoiceDatePay` датой оплаты считается `closedate`; неоплаченный без даты оплаты при непустом диапазоне отсекается.
- `opportunity = 0` — норма (переплату переносят в другой счёт).
- «% сбора» = Оплачено / Должен всего; при нулевой сумме — «—».

## Как адаптировать под другой портал

Значения ниже специфичны для исходного портала — проверь их на своём через вебхук:

| Что | Где в коде | Как узнать на своём портале |
|---|---|---|
| Стадия «Оплачен» `DT31_5:P` | `STAGE_PAID`, `modules/application/aggregator.js` | `crm.status.list` с `filter: {ENTITY_ID: 'SMART_INVOICE_STAGE_<categoryId>'}` или `crm.item.list` + `stageId` |
| Стадия «Не оплачен» `DT31_5:D` | `STAGE_FAILED`, `modules/application/data-loader.js` | то же |
| Поле «Дата оплаты» `ufCrmSmartInvoiceDatePay` | `INVOICE_SELECT`, `isDatePayInRange` в `data-loader.js` | `crm.item.fields` с `entityTypeId: 31` |
| Тип сущности `31` (счета) | `ENTITY_TYPE_INVOICE`, `data-loader.js` | у Smart Invoice всегда 31 |

Если у счетов несколько воронок (`categoryId`), стадии у каждой свои (`DT31_<categoryId>:P`) — тогда правило «оплачен» нужно расширить, это бизнес-решение.

## Подводные камни REST Битрикса

- Имена полей строго как в `*.fields`: `crm.item.list` — camelCase (`closedate`, не `closeDate`; `assignedById`); `crm.contact.list` и `user.get` — UPPER_SNAKE (`LAST_NAME`, `ID`).
- Вебхук с операторами фильтра (`>=closedate`, `!=stageId`) работает **только** как POST с `Content-Type: application/json`. GET и form-urlencoded **молча игнорируют** фильтр — получишь все записи.
- Классический `batch` — не больше 50 команд. Batch v3 CRM-методы не поддерживает.
- В BX24 SDK `res.next` — функция, которая сама делает следующий запрос; не вызывать. Пагинация — по `total`.
- `user.get` без фильтра по `ACTIVE` возвращает и уволенных — это нужно (у многих счетов уволенные ответственные).

## Конвенции

- Файлы `kebab-case`, константы `SCREAMING_SNAKE_CASE`, только именованные экспорты.
- Логи с префиксом модуля (`[data-loader] ...`); подробные — через `logDebug` (включены в dev и при `?DEBUG=true`).
- Данные из CRM (ФИО) — только через `textContent`, без `innerHTML`.
- Ошибки: нижние слои бросают `Error('<module>: <step> failed: ...')`, UI показывает через `ui-helpers.showError`. Никаких `alert()`.
- `vendor/*` не редактировать — только заменять целиком с обновлением `vendor/VERSIONS.txt`.
- Никаких внешних CDN, кроме `BX24.js` с `api.bitrix24.com`.
- Новая логика — с тестами в `tests/` (`node:test`, без внешних тест-фреймворков).

## Секреты и данные — обязательно

- Вебхук (`https://<portal>/rest/<id>/<token>/`) — это пароль. Он живёт только в `.env` и `dev-config.local.js` (оба в `.gitignore`, `pack.mjs` их не пакует и ещё грепает архив на шаблон вебхука).
- Никогда не печатай вебхук в чат, логи, коммиты, документацию. В логах — только факт наличия (`hasWebhookConfig=true`).
- Не коммить реальные ФИО, суммы и прочие данные клиентов портала — в тестах и документации только вымышленные.

## Порядок работы

1. Прочитай `NEXT.md` — там где остановились и что дальше.
2. Крупное изменение — сначала план (документом или в чате), потом код.
3. После правок: `npm test`; если менялся UI — открой локально и проверь в браузере.
4. Перед выкладкой: `npm run pack`, затем `unzip -l dist/fin25_otch.zip` — в архиве не должно быть `.env`, `dev-config*`, `tests/`, `*.md`, `package.json`.
5. ZIP на портал загружает человек (`docs/install.md`), не агент.
6. После изменения поведения обнови `docs/` и `NEXT.md`.
7. Не коммить и не пушь без явной просьбы.
