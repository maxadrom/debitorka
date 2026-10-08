'use strict';

// modules/infrastructure/api-client.js
// Единая точка обращения к Битрикс24.
// Контракт:
//   callMethod(method, params) → { result, total }
//   callBatch([[method, params], ...]) → [{ result, total }, ...]  (halt: первая ошибка бросается)
// Ошибки REST приводятся к Error('api-client: <method> failed: <description>') с полями status/code.
//
// Портал (BX24.callMethod/callBatch) или dev (POST JSON на webhook) — по IS_DEV из env.js.

import { IS_DEV, logDebug } from '../env.js';

// SECURITY GUARD. Если каким-то образом dev-config просочился в портальный контекст —
// удаляем webhook URL и кричим в консоль. Это последняя линия обороны после .gitignore + pack.mjs.
// В Node (тесты) этот блок пропускается.
if (typeof window !== 'undefined' && window.BX24 && window.B24_WEBHOOK_URL) {
  delete window.B24_WEBHOOK_URL;
  console.error('[api-client] dev-config detected in portal context — webhook disabled for safety');
}

export const BATCH_LIMIT = 50;

function restError(message, { status, code } = {}) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

// ---------- Portal mode ----------

// res.error() в BX24 SDK — ajaxError: {status, ex: {error, error_description}};
// в тестах и старых версиях встречается плоский {error, error_description}.
function bxError(message, err) {
  const ex = err?.ex && typeof err.ex === 'object' ? err.ex : err || {};
  const desc = ex.error_description || ex.error || (typeof err?.ex === 'string' && err.ex) || String(err);
  const code = typeof ex.error === 'string' ? ex.error : undefined;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  return restError(`${message}: ${desc}`, { status, code });
}

// В BX24 JS SDK `res.next` — функция-триггер автоподгрузки следующей страницы,
// а НЕ индекс: её вызов делает лишний REST-запрос и под квотой ~2 req/sec даёт
// каскад 503. Пагинация идёт по total в data-loader, поэтому next не читаем.
function bxResult(res) {
  return {
    result: res.data(),
    total: typeof res.total === 'function' ? res.total() : undefined,
  };
}

function bxCallMethod(method, params) {
  return new Promise((resolve, reject) => {
    window.BX24.callMethod(method, params, (res) => {
      const err = res.error();
      if (err) reject(bxError(`api-client: ${method} failed`, err));
      else resolve(bxResult(res));
    });
  });
}

function bxCallBatch(commands) {
  return new Promise((resolve, reject) => {
    window.BX24.callBatch(commands, (results) => {
      try {
        resolve(results.map((r, i) => {
          const err = r.error();
          if (err) throw bxError(`api-client: batch[${i}] failed`, err);
          return bxResult(r);
        }));
      } catch (e) {
        reject(e);
      }
    }, true);
  });
}

// ---------- Dev mode ----------

function getWebhook() {
  if (window.BX24) {
    // Страховка: даже если IS_DEV какой-то ошибкой стало true в портале — не идём через webhook.
    throw new Error('api-client: webhook fallback forbidden inside portal');
  }
  const url = window.B24_WEBHOOK_URL;
  if (!url) {
    throw new Error('api-client: dev mode requires dev-config.local.js (copy from dev-config.example.js or run npm run dev:setup)');
  }
  return url.endsWith('/') ? url : url + '/';
}

// Сериализует params в query-string в формате Битрикса (PHP parse_str):
// вложенные объекты → filter[>=closedate]=…, массивы → select[0]=…&select[1]=….
// Ключи и значения кодируются encodeURIComponent, скобки остаются литеральными.
// Проверено на портале (2026-10-05): операторы >=, <=, !=, @ внутри batch-команд
// дают тот же total, что и JSON-вызов.
export function toBitrixQuery(params) {
  const parts = [];
  const walk = (prefix, value) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const key = encodeURIComponent(k);
        walk(prefix ? `${prefix}[${key}]` : key, v);
      }
      return;
    }
    const str = value === null ? '' : typeof value === 'boolean' ? (value ? 'Y' : 'N') : String(value);
    parts.push(`${prefix}=${encodeURIComponent(str)}`);
  };
  walk('', params || {});
  return parts.join('&');
}

function describeRestError(err) {
  return (err && (err.error_description || err.error)) || String(err);
}

// Разбирает ответ классического `batch` ({result: {result, result_error, result_total}})
// к контракту callBatch: массив {result, total}. Первая ошибка бросается (halt=1).
export function parseBatchResponse(json, count) {
  const body = (json && json.result) || {};
  const results = body.result || {};
  const errors = body.result_error || {};
  const totals = body.result_total || {};
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const err = errors[i];
    if (err) {
      throw restError(`api-client: batch[${i}] failed: ${describeRestError(err)}`, { code: err.error });
    }
    // При halt=1 Битрикс прекращает выполнение после первой ошибки — пустой
    // результат без ошибки означает, что команда не выполнялась.
    if (!(i in results)) throw new Error(`api-client: batch[${i}] failed: no result`);
    out.push({ result: results[i], total: totals[i] });
  }
  return out;
}

async function postWebhook(method, body) {
  const r = await fetch(`${getWebhook()}${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  // Не используем r.ok как единственный признак: Битрикс может вернуть 200 с error в теле,
  // но и 4xx с описанием в JSON. В обоих случаях парсим тело.
  let json;
  try {
    json = await r.json();
  } catch {
    throw restError(`api-client: ${method} failed: invalid JSON response (status=${r.status})`, { status: r.status });
  }
  if (json && json.error) {
    throw restError(`api-client: ${method} failed: ${describeRestError(json)}`, { status: r.status, code: json.error });
  }
  return json;
}

async function devCallMethod(method, params) {
  const json = await postWebhook(method, params);
  return { result: json.result, total: json.total };
}

// Настоящий batch: один POST на {webhook}batch, команды — строки "method?query".
async function devCallBatch(commands) {
  const cmd = commands.map(([method, params]) => {
    const qs = toBitrixQuery(params);
    return qs ? `${method}?${qs}` : method;
  });
  const json = await postWebhook('batch', { halt: 1, cmd });
  return parseBatchResponse(json, commands.length);
}

// ---------- Retry ----------

const RETRY_CODES = new Set(['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT']);
const RETRY_DELAYS = [500, 1500];

// Транзиентные ошибки: сеть (TypeError от fetch, status 0 в BX24), HTTP 503,
// лимиты Битрикса. Бизнес-ошибки (ACCESS_DENIED, INVALID_CREDENTIALS, фильтр) — нет.
export function isRetryable(err) {
  if (!err) return false;
  if (err instanceof TypeError) return true;
  if (err.status === 503 || err.status === 0) return true;
  return RETRY_CODES.has(err.code);
}

export async function withRetry(fn, { attempts = 3, delays = RETRY_DELAYS, label = '' } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] || 0;
      const reason = err.code || (err.status !== undefined ? `status=${err.status}` : err.name);
      logDebug(`[api-client] retry ${attempt}/${attempts - 1} method=${label} reason=${reason}`);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------- Public API ----------

export async function callMethod(method, params = {}) {
  const t0 = performance.now();
  const out = await withRetry(
    () => (IS_DEV ? devCallMethod(method, params) : bxCallMethod(method, params)),
    { label: method }
  );
  logDebug(`[api-client.callMethod] ${method} ok in ${(performance.now() - t0).toFixed(0)}ms`);
  return out;
}

export async function callBatch(commands) {
  if (commands.length === 0) return [];
  if (commands.length > BATCH_LIMIT) {
    throw new Error(`api-client: callBatch: command count ${commands.length} exceeds limit ${BATCH_LIMIT}`);
  }
  const t0 = performance.now();
  const out = await withRetry(
    () => (IS_DEV ? devCallBatch(commands) : bxCallBatch(commands)),
    { label: `batch(n=${commands.length})` }
  );
  logDebug(`[api-client.callBatch] n=${commands.length} ok in ${(performance.now() - t0).toFixed(0)}ms`);
  return out;
}
