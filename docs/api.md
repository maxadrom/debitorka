# REST API Битрикс24 — то, что использует приложение

Все вызовы идут через `modules/infrastructure/api-client.js`. На портале — `BX24.callMethod` / `BX24.callBatch`, в dev — POST к webhook (`B24_WEBHOOK_URL`).

## Используемые методы

### `crm.item.list` (Smart Invoice 2.0, `entityTypeId=31`)

Загружает список счетов. Поля приходят в **camelCase** (особенность сущностей нового CRM).

**Параметры:**

```js
{
  entityTypeId: 31,
  filter: {
    '>=closedate': 'YYYY-MM-DD',          // срок оплаты от
    '<=closedate': 'YYYY-MM-DD',          // срок оплаты до
    '!=stageId': 'DT31_5:D'               // отсечь «Не оплачен» на сервере
  },
  select: ['id', 'contactId', 'assignedById', 'opportunity', 'stageId', 'closedate',
           'ufCrmSmartInvoiceDatePay'],
  start: 0
}
```

**Ответ:**

```js
{
  result: { items: [...50 счетов...] },
  total: 1234
}
```

**Замечания:**

- Операторы фильтра (`>=closedate`, `!=stageId`, `@assignedById`) при прямом curl работают **только** при `Content-Type: application/json` (POST-тело). Form-urlencoded НЕ работает. На портале через `BX24.callMethod` сериализация корректна.
- Фильтр «Ответственный» — это **ответственный за счёт** (`crm.item.list.assignedById`). Не путать с «ответственным за контакт» (`crm.contact.list.ASSIGNED_BY_ID`). До 2026-05-06 приложение использовало второй вариант — теперь только первый. С 2026-10-08 `@assignedById` на сервер **не отправляется**: грузятся все счета периода (они нужны для списка ответственных), фильтр по выбранным применяется на клиенте. Счёт без ответственного получает ключ `0` («Без ответственного»).
- Стадии счёта (`stageId`, воронка одна — `categoryId=5` «Общее»; полный список — в [research.md](research.md)):
  - `DT31_5:P` — «Оплачен» (semantics S)
  - `DT31_5:D` — «Не оплачен» (semantics F, отсекаем серверным фильтром)
  - `DT31_5:N`, `DT31_5:S`, `DT31_5:UC_*` — в работе (любая ≠ `:P` и ≠ `:D`)

### `crm.contact.list`

Загружает список контактов. Поля — **UPPER_SNAKE** (старый CRM).

**Параметры:**

```js
// Контакты по их id (после загрузки счетов) — единственный сценарий вызова в приложении.
// До 50 ID в команде, команды отправляются через callBatch (до 50 команд = 2 500 контактов).
{
  filter: { ID: [100, 101, 102] },
  select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME']
}
```

> Запрос `crm.contact.list` с фильтром по `ASSIGNED_BY_ID` приложение **не делает** —
> ответственный определяется на уровне счёта по полю `assignedById` из `crm.item.list`.

**Ответ:**

```js
{
  result: [...контакты...],
  total: 50
}
```

**Замечания:**

- Поле `ID` приходит как строка → парсим через `Number(c.ID)`.
- ФИО собираем как `[LAST_NAME, NAME, SECOND_NAME].filter(Boolean).join(' ').trim()`.
- Если контакт удалён, его не вернёт API — fallback в UI: `'Контакт #<id>'`.

### `user.get`

Загружает ФИО ответственных за счета периода — для multi-select «Ответственный» и вкладки «Дебиторка по сотрудникам». Пользователи запрашиваются по ID из счетов (плюс выбранные из URL), **включая уволенных**: на портале 20 из 23 владельцев счетов уволены, а список `ACTIVE: 'Y'` давал 12 пользователей, в основном без счетов.

**Параметры:**

```js
{ FILTER: { ID: [19, 20, 31] }, start: 0 }
```

**Ответ:**

```js
{ result: [...пользователи...], total: 3 }
```

Из ответа берутся `ID`, `LAST_NAME`, `NAME`, `SECOND_NAME`, `ACTIVE`; уволенные (`ACTIVE === false`) показываются с пометкой «(уволен)», не найденные (в том числе не вернувшиеся из `user.get`) — `'Пользователь #<id>'` с `active: false`; эту подпись проставляет только `loadUsersByIds`, так что в `users` есть каждый запрошенный ID. Вызывается параллельно с `crm.contact.list` при каждой загрузке отчёта; отдельной кнопки обновления списка нет.

Все списочные методы (`crm.item.list`, `user.get`) грузятся одним хелпером `fetchAll` в `data-loader.js`: первая страница одиночным вызовом (ради `total`), остальные — `callBatch` по 50 команд. Пагинация по `total`, а не по `next`: в BX24 SDK `res.next` — функция-триггер лишнего запроса, поэтому `api-client.js` поле `next` не возвращает.

## Пакетные вызовы (`callBatch`)

Через `callBatch` (классический `batch`, **до 50 команд** — лимит платформы) идут:

- страницы счетов `crm.item.list` (`start: 50`, `100`, …) после первого вызова с `total`;
- контакты `crm.contact.list` по ID (команда = 50 ID);
- страницы `user.get` (если ответственных больше 50).

```js
// Пример: загрузить страницы со start=50, 100, …, 1450
const cmds = [
  ['crm.item.list', { entityTypeId: 31, filter, select, start: 50 }],
  ['crm.item.list', { entityTypeId: 31, filter, select, start: 100 }],
  // ...
];
await callBatch(cmds); // всегда halt: первая ошибка прерывает batch и бросается
```

`callBatch` принимает только массив `[method, params]` и возвращает массив `{ result, total }` в том же порядке, чтобы `data-loader.js` не различал режимы.

**Dev-режим:** один POST `{webhook}batch` с телом `{"halt": 1, "cmd": ["crm.item.list?entityTypeId=31&filter[%3E%3Dclosedate]=…", …]}`. Параметры команд сериализует `toBitrixQuery` (вложенные `filter[...]`, массивы `select[0]=…`, ключи и значения через `encodeURIComponent`). Операторы `>=`, `<=`, `!=`, `@` внутри batch-команд проверены на портале: `total` совпадает с JSON-вызовом. Ответ `result.result[i]`, `result.result_total[i]`, `result.result_error[i]` разбирает `parseBatchResponse`.

**Batch v3** (`/rest/api/{uid}/{token}/batch`) на портале **не поддерживает** `crm.item.list`, `crm.contact.list`, `user.get` (`BITRIX_REST_V3_EXCEPTION_METHODNOTFOUNDEXCEPTION`, проверено 2026-10-05 на прежнем портале) — используем классический `batch`. Перепроверить при следующей доработке.

Портал маленький (~1 740 счетов всего, за типичный месяц ~5–15), поэтому обычно хватает одного вызова `crm.item.list`; batch нужен только на длинных периодах (год — ~400 счетов = 1 вызов + 1 batch на 8 команд).

## Повтор при транзиентных ошибках

`callMethod` и `callBatch` (портал и dev) обёрнуты в `withRetry`: до 3 попыток, паузы 500 и 1 500 мс. Повторяются только сетевые ошибки (`TypeError: Failed to fetch`, status 0), HTTP 503, `QUERY_LIMIT_EXCEEDED`, `OPERATION_TIME_LIMIT`. Бизнес-ошибки (`ACCESS_DENIED`, `INVALID_CREDENTIALS`, ошибки фильтра) пробрасываются сразу. Решение принимается по полям ошибки `status`/`code`, которые оба режима (портал и dev, включая ошибки внутри batch) заполняют одинаково, — не по тексту сообщения.

## Бизнес-правила

### `is_paid`

```
is_paid := stageId === 'DT31_5:P'
```

Любая другая стадия (`DT31_5:N`, `DT31_5:S`, `DT31_5:UC_*`, в том числе «Замороженные платежи» `DT31_5:UC_YUR7QW`) — счёт в работе. Стадия `DT31_5:D` («Не оплачен») отсекается серверным фильтром и в отчёт не попадает.

### `is_overdue`

```
is_overdue := !is_paid AND dateOnly(closedate) < dateOnly(today)
```

Сравнение **строго по дате** (без времени и TZ). Внутри `aggregator.js` используется хелпер `dateOnly()`, который из ISO-строки вида `'2026-04-30T23:59:59+03:00'` берёт `'2026-04-30'` и преобразует в `new Date(2026, 3, 30)` — это устраняет drift из-за часовых поясов.

### Колонки

| Колонка | Расчёт |
|---------|--------|
| Должен всего | `SUM(opportunity)` по всем счетам контакта (на вкладке «по сотрудникам» — ответственного) |
| Оплачено | `SUM(opportunity)` где `is_paid = 1` |
| Просрочено | `SUM(opportunity)` где `is_overdue = 1` |
| Остаток к оплате | `SUM(opportunity)` где `is_paid = 0` |

### % сбора дебиторки

```
collectionRate := totals.paid / totals.amount   // null, если totals.amount = 0 → в UI «—»
```

Считается по текущему фильтру (`aggregator.collectionRate`), показывается вверху панели фильтров с подписью «Оплачено X из Y».
