# Локальная разработка

Приложение работает в двух режимах:

| Режим | Признак | API-обмен |
|-------|---------|-----------|
| **portal** | `window.BX24` определён | `BX24.callMethod` / `BX24.callBatch` от имени установившего пользователя |
| **dev** | `window.BX24` отсутствует | `fetch` к `B24_WEBHOOK_URL` из `dev-config.local.js` |

Режим определяется СТРОГО по наличию `window.BX24` (`modules/env.js`). Параметр `?DEBUG=true` влияет только на уровень логирования и **не переключает режим** — это страховка от того, чтобы в портале случайно уйти на webhook.

## С чего начать

Код — в публичном репозитории https://github.com/maxadrom/debitorka.

1. Получите копию проекта и подготовьте окружение — см. [Подготовка окружения](#подготовка-окружения).
2. Получите **свой** входящий вебхук — см. [Получить webhook](#получить-webhook-для-dev). Вебхуки не передаются между разработчиками и не лежат в репозитории.
3. Прочитайте `CLAUDE.md` (архитектура, бизнес-правила, подводные камни REST) и `NEXT.md` (где остановились).
4. `npm test` — все тесты должны быть зелёными до первой правки.

## Подготовка окружения

```bash
git clone https://github.com/maxadrom/debitorka.git
cd debitorka
npm run dev:setup -- https://<портал>/rest/<ID>/<токен>/   # запишет вебхук в .env и сгенерирует dev-config.local.js
```

Нужны только git и Node.js 20+; Python и глобальные пакеты не нужны. `npm install` (archiver в локальный `node_modules`) — только если для `npm run pack` нет системной утилиты `zip` (Windows).

```bash
npm run dev:setup          # если .env правили вручную — перегенерировать dev-config.local.js
```

`dev-config.local.js` — это маленький файл, выставляющий `window.B24_WEBHOOK_URL`. Он подключается в `index.html` ДО `app.js`, чтобы при старте `app.js` webhook уже был доступен. **В production файла нет** — браузер вернёт 404, `window.B24_WEBHOOK_URL` останется `undefined`, режим переключится в `portal`.

Из того же webhook-URL берётся адрес портала (`PORTAL_ORIGIN` в `modules/env.js`): в dev клик по ФИО контакта открывает `<origin>/crm/contact/details/<id>/` в новой вкладке. Отдельной настройки адреса портала нет — при переезде достаточно сменить вебхук.

### Получить webhook (для dev)

1. На портале `<portal>.bitrix24.ru`: **Приложения → Разработчикам → Другое → Входящий вебхук**.
2. Дайте права только `crm` и `user`.
3. Скопируйте URL вида `https://<portal>.bitrix24.ru/rest/<USER_ID>/<TOKEN>/`.
4. `npm run dev:setup -- <URL>` (или впишите в `.env` и запустите `npm run dev:setup`).
5. После работ удалите вебхук на портале — [adapt-to-portal.md](adapt-to-portal.md), шаг 8.

После работ удалите вебхук: **Разработчикам → «Интеграции»** → вебхук → **Удалить** (подробнее — [adapt-to-portal.md](adapt-to-portal.md), шаг 8).

> **Важно:** webhook никогда не должен попадать ни в коммит, ни в ZIP. `.gitignore` и `pack.mjs` это страхуют, но всё равно проверяйте `dist/<APP_CODE>.zip` командой `unzip -l`.

## Запуск приложения локально

```bash
npm run serve          # → http://localhost:8081/index.html (PORT=8090 npm run serve — другой порт)
```

`scripts/serve.mjs` — статический сервер на Node без зависимостей, с заголовком `Cache-Control: no-store`: после правок браузер всегда берёт свежие `modules/*.js`, hard reload не нужен. `.env` он не отдаёт. В Claude Code тот же сервер запускается конфигурацией «static» из `.claude/launch.json`. Python для разработки не нужен.

Прямое открытие через `file://` тоже работает в большинстве браузеров, но `BX24.js` загружается с `https://api.bitrix24.com/api/v1/`, поэтому может потребоваться cors-relaxed окружение. Сервер на localhost — стабильнее.

## Логирование

- В **dev-режиме** logger печатает все шаги загрузки (`[data-loader]`, `[api-client]`, `[ui]`).
- На портале по умолчанию молчит. Чтобы включить verbose: добавьте `?DEBUG=true` к URL.
- **Никогда не логируйте** `B24_WEBHOOK_URL`, токены, полные `params`. Логировать допустимо `Object.keys(params)` или сокращённый объект (`{filterKeys: [...]}`)

## Тесты

```bash
npm test
```

Запускает `node --test tests/*.test.js`. Тесты:

- `tests/aggregator.test.js` — юнит-тесты чистой агрегации (граничные случаи, TZ, `contactId == null`).
- `tests/data-loader.test.js` — тесты через DI-mock апи-клиента (порядок вызовов, пагинация, контакты через batch, ошибки, фильтр по ответственному на клиенте без `@assignedById`, список ответственных периода, совпадение итогов `byContact`/`byAssignee`).
- `tests/api-client.test.js` — портальный режим (мок `window.BX24`), `toBitrixQuery`, разбор ответа `batch`, `withRetry`.
- `tests/filters.test.js` — дефолты фильтров и URL.
- `tests/xlsx-export.test.js`, `tests/vendor-css.test.js` — экспорт и подключение стилей vendor.

Всего 55 тестов (2026-10-14). Живая сверка с порталом — `npm run check:live` (сеть, вебхук из `.env`; месяц, максимум квартал; со встроенной независимой перепроверкой). Через вебхук — только чтение.

Никаких сборщиков, ничего сетевого. Node ≥ 20.

## Сборка ZIP

```bash
npm run pack
```

`pack.mjs` собирает в `dist/fin25_otch.zip` только whitelist (`index.html`, `app.js`, `styles.css`, `modules/**`, `vendor/**`, `manifest/**`). После сборки выполняет sanity-check на blacklist и проверяет размер ≤ 500 KB. При нарушении — `process.exit(1)`.

## Чек-лист перед коммитом

- [ ] `npm test` — все тесты зелёные.
- [ ] `npm run pack` — размер ≤ 500 KB, sanity-check passed.
- [ ] `unzip -l dist/fin25_otch.zip` — нет `.env`, `dev-config.local.js`, `tests/`, `*.md`, `package.json`.
- [ ] DevTools на dev-режиме — нет ошибок в консоли при открытии `index.html`.
- [ ] Если меняли логику агрегации — добавили или обновили тесты в `tests/aggregator.test.js`.
