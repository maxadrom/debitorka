'use strict';

// modules/env.js
// Единая точка определения режима выполнения и уровня логирования.
//
// Контракт:
// - Режим (`portal` | `dev`) определяется по «работоспособности» window.BX24.
//   Скрипт api/v1/ всегда выставляет `window.BX24 = {}` в самом начале,
//   но если запуск не внутри портального iframe (нет window.name с DOMAIN|APP_SID)
//   SDK на финальном шаге делает `BX24 = null; throw 'Unable to initialize…'`.
//   Поэтому на localhost `window.BX24 === null`, а `typeof null === 'object'` —
//   проверкой по `typeof === 'undefined'` это НЕ ловится. Раньше из-за этого
//   локальный запуск падал на `window.BX24.callMethod` (null is not an object).
//   Теперь проверяем строго: BX24 пригоден, если это объект и у него есть
//   функция `callMethod`. Иначе — dev-режим (через webhook).
// - Параметр URL `?DEBUG=true` НЕ переключает режим — только уровень логирования.
// - В портале webhook не используется никогда (см. api-client.js).

const isBrowser = typeof window !== 'undefined';

// В Node (тесты) — sensible defaults, без обращения к window.
export const IS_DEV = isBrowser && typeof window.BX24?.callMethod !== 'function';

const debugParam = isBrowser
  ? new URL(window.location.href).searchParams.get('DEBUG')
  : null;
const IS_DEBUG = debugParam === 'true' || debugParam === '1';

// Verbose-логирование разрешено в dev всегда; в портале — только при ?DEBUG=true; в Node — выключено.
export const LOG_VERBOSE = isBrowser && (IS_DEV || IS_DEBUG);

// Общие логгеры: префикс модуля пишется в самой строке (`[data-loader] ...`).
export function logInfo(...args) {
  console.log(...args);
}

export function logDebug(...args) {
  if (LOG_VERBOSE) console.log(...args);
}

export function logWarn(...args) {
  if (LOG_VERBOSE) console.warn(...args);
}

if (LOG_VERBOSE) {
  // Намеренно не логируем сам URL вебхука — только факт его наличия.
  const hasWebhookConfig = typeof window.B24_WEBHOOK_URL === 'string' && window.B24_WEBHOOK_URL.length > 0;
  console.log(
    `[env] mode=${IS_DEV ? 'dev' : 'portal'} debug=${IS_DEBUG} hasWebhookConfig=${hasWebhookConfig}`
  );
}

// Origin портала для fallback-URL в dev-режиме (BX24.openSlider недоступен → window.open).
// Берётся из webhook-URL (dev-config.local.js), отдельной настройки нет. Сам URL не логируем.
function webhookOrigin() {
  try {
    return new URL(window.B24_WEBHOOK_URL).origin;
  } catch {
    return null;
  }
}
export const PORTAL_ORIGIN = IS_DEV ? webhookOrigin() : null;
