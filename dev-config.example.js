// DEV-ONLY. Скопируйте этот файл в dev-config.local.js и подставьте реальный webhook.
// dev-config.local.js гитигнорится и НИКОГДА не попадает в ZIP-артефакт (см. pack.mjs).
//
// На портале файл отсутствует — браузер вернёт 404, window.B24_WEBHOOK_URL останется undefined,
// detectMode() вернёт 'portal' (по наличию window.BX24), и api-client пойдёт через BX24.*.
window.B24_WEBHOOK_URL = 'https://<portal>.bitrix24.ru/rest/<USER_ID>/<TOKEN>/';
