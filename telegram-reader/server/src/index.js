// Точка входа backend: HTTP API для Mini App и приём апдейтов Telegram.
//
// Транспорт бота выбирается переменной BOT_MODE:
//   polling — бот сам опрашивает Telegram (значение по умолчанию, так удобно локально);
//   webhook — Telegram стучится на ${PUBLIC_API_BASE}/telegram/webhook.
// На сервере нужен webhook: запрос от Telegram — это то, что будит заснувшую машину,
// а long polling держал бы её включённой круглосуточно.
import { webhookCallback } from 'grammy';
import { loadEnv } from './env.js';
import { startApi } from './api.js';
import { cacheDir } from './audio-store.js';
import { HANDLED_UPDATES, createBot, isValidToken } from './bot.js';
import { describeTts, isTtsConfigured, isTtsEnabled, readTtsConfig } from './tts.js';
loadEnv();

const apiPort = Number(process.env.API_PORT || 3001);
const miniAppUrl = (process.env.MINI_APP_URL || '').trim();
const token = (process.env.BOT_TOKEN || '').trim();
const publicApiBase = (process.env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
const botMode = (process.env.BOT_MODE || 'polling').trim().toLowerCase();
const webhookSecret = (process.env.WEBHOOK_SECRET || '').trim();

const WEBHOOK_PATH = '/telegram/webhook';
// grammY обязан ответить Telegram до этого срока. Наш обработчик укладывается: синтез
// уходит в очередь в фоне, а в ответ уходит только статус поста.
const WEBHOOK_TIMEOUT_MS = 10_000;

// Ключ TTS печатать нельзя: describeTts сообщает только факт наличия ключа.
const ttsConfig = readTtsConfig();
console.log(`[tts] ${describeTts(ttsConfig)}`);
console.log(`[tts] аудио кэшируется в ${cacheDir()}`);
if (isTtsEnabled(ttsConfig) && !isTtsConfigured(ttsConfig)) {
  console.log('[tts] Провайдер выбран, но не настроен: впишите TTS_API_KEY в .env или переключитесь на TTS_PROVIDER=macos-say.');
}

// Публичный адрес backend нужен Mini App, чтобы обратиться к API; localhost в проде не подходит.
console.log(
  publicApiBase
    ? `[api] PUBLIC_API_BASE для Mini App: ${publicApiBase}`
    : '[api] PUBLIC_API_BASE не задан: Mini App нужно собрать с этим адресом (см. docs/poc.md, раздел 7).',
);

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

// В webhook-режиме адрес и секрет — не украшение: без HTTPS-адреса Telegram не примет
// вебхук, а без секрета его сможет дёрнуть любой, кто узнает путь. Поэтому проверяем
// настройки до запуска и не делаем вид, что бот работает.
function webhookProblems() {
  const problems = [];
  if (!publicApiBase.startsWith('https://')) problems.push('PUBLIC_API_BASE должен быть HTTPS-адресом backend');
  if (!webhookSecret) problems.push('WEBHOOK_SECRET не задан: вебхук был бы открыт любому, кто знает адрес');
  return problems;
}

if (!isValidToken(token)) {
  // Токен не печатаем: сообщаем только факт и что делать.
  startApi({ port: apiPort });
  console.log('[bot] BOT_TOKEN не задан или имеет неверный формат — бот не запущен.');
  console.log('[bot] Впишите токен от @BotFather в файл .env в корне проекта (BOT_TOKEN=...) и перезапустите.');
  console.log('[api] HTTP API продолжает работать: Mini App можно открыть вручную в браузере.');
} else {
  const { bot, scrub, canSynthesize, provider } = createBot({
    token,
    miniAppUrl,
    config: ttsConfig,
    supportContact: process.env.SUPPORT_CONTACT,
    onLog: (message) => console.log(message),
    onError: (message) => console.error('[bot] ошибка:', message),
  });

  const problems = botMode === 'webhook' ? webhookProblems() : [];
  for (const problem of problems) console.log(`[bot] ${problem}.`);

  // Режим «off» — это webhook без нужных настроек. Молча уходить в long polling нельзя:
  // при засыпании машины опрос замирает и посты доходят только после случайной побудки.
  // Лучше честно не запускать бота и сказать об этом в логах.
  let mode = botMode;
  if (mode === 'webhook' && problems.length > 0) {
    console.log('[bot] BOT_MODE=webhook, но настройки неполные: бот не запущен, апдейты не принимаются.');
    mode = 'off';
  }

  let api;
  let stopBot = async () => {};

  if (mode === 'webhook') {
    const url = `${publicApiBase}${WEBHOOK_PATH}`;
    const handler = webhookCallback(bot, 'http', {
      secretToken: webhookSecret,
      timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
    });
    api = startApi({ port: apiPort, webhook: { path: WEBHOOK_PATH, handler } });

    // Вебхук регистрируем после того, как порт открыт: иначе Telegram может постучаться в пустоту.
    await waitForListening(api);
    await bot.init();
    // drop_pending_updates не ставим: посты, отправленные пока машина спала, должны дойти.
    await bot.api.setWebhook(url, { secret_token: webhookSecret, allowed_updates: HANDLED_UPDATES });

    console.log(`[bot] апдейты принимаются вебхуком: ${url}`);
    console.log(`[bot] запущен как @${bot.botInfo.username}`);
  } else {
    api = startApi({ port: apiPort });

    if (mode === 'polling') {
      // Старый вебхук уводил бы апдейты на прежний адрес, и long polling остался бы без них.
      await bot.api.deleteWebhook().catch(() => {});

      console.log('[bot] BOT_TOKEN найден, запускаю long polling…');
      console.log(
        miniAppUrl.startsWith('https://')
          ? `[bot] Mini App URL: ${miniAppUrl}`
          : '[bot] MINI_APP_URL не задан или не HTTPS — кнопка Mini App показываться не будет.',
      );

      // Меню команд уходит в Bot API отдельным запросом и не задерживает long polling:
      // бот должен начать принимать посты, даже если api.telegram.org отвечает медленно.
      bot.start({
        allowed_updates: HANDLED_UPDATES,
        onStart: (info) => console.log(`[bot] запущен как @${info.username}`),
      });
      stopBot = () => bot.stop();
    }
  }

  if (mode !== 'off') {
    console.log(
      canSynthesize
        ? `[bot] аудио готовится сразу после поста (${provider}); «⏹ Остановить» прерывает только операцию пользователя`
        : `[bot] провайдер ${provider} не настроен: посты принимаются, но синтез не запускается`,
    );
  }

  const shutdown = async () => {
    await stopBot();
    api.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Страховка: если grammY выбросит ошибку с URL запроса, вырежем из неё токен.
  process.on('unhandledRejection', (reason) => {
    console.error('[bot] unhandledRejection:', scrub(reason?.message ?? reason));
  });
}
