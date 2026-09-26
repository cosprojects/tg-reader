// Точка входа PoC-сервера: сначала поднимаем HTTP API для Mini App,
// затем, если токен задан корректно, запускаем бота.
import { loadEnv } from './env.js';
import { startApi } from './api.js';
import { cacheDir } from './audio-store.js';
import { createBot, isValidToken } from './bot.js';
import { describeTts, isTtsConfigured, isTtsEnabled, readTtsConfig } from './tts.js';
loadEnv();

const apiPort = Number(process.env.API_PORT || 3001);
const miniAppUrl = (process.env.MINI_APP_URL || '').trim();
const token = (process.env.BOT_TOKEN || '').trim();

const api = startApi({ port: apiPort });

// Ключ TTS печатать нельзя: describeTts сообщает только факт наличия ключа.
const ttsConfig = readTtsConfig();
console.log(`[tts] ${describeTts(ttsConfig)}`);
console.log(`[tts] аудио кэшируется в ${cacheDir()}`);
if (isTtsEnabled(ttsConfig) && !isTtsConfigured(ttsConfig)) {
  console.log('[tts] Провайдер выбран, но не настроен: впишите TTS_API_KEY в .env или переключитесь на TTS_PROVIDER=macos-say.');
}

// Публичный адрес backend нужен Mini App, чтобы обратиться к API; localhost в проде не подходит.
const publicApiBase = (process.env.PUBLIC_API_BASE || '').trim();
console.log(
  publicApiBase
    ? `[api] PUBLIC_API_BASE для Mini App: ${publicApiBase}`
    : '[api] PUBLIC_API_BASE не задан: Mini App нужно собрать с этим адресом (см. docs/poc.md, раздел 7).',
);

if (!isValidToken(token)) {
  // Токен не печатаем: сообщаем только факт и что делать.
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

  console.log('[bot] BOT_TOKEN найден, запускаю long polling…');
  console.log(
    miniAppUrl.startsWith('https://')
      ? `[bot] Mini App URL: ${miniAppUrl}`
      : '[bot] MINI_APP_URL не задан или не HTTPS — кнопка Mini App показываться не будет.',
  );
  console.log(
    canSynthesize
      ? `[bot] аудио готовится сразу после поста (${provider}); «⏹ Остановить» прерывает только операцию пользователя`
      : `[bot] провайдер ${provider} не настроен: посты принимаются, но синтез не запускается`,
  );

  // Меню команд уходит в Bot API отдельным запросом и не задерживает long polling:
  // бот должен начать принимать посты, даже если api.telegram.org отвечает медленно.
  bot.start({
    onStart: (info) => console.log(`[bot] запущен как @${info.username}`),
  });

  const shutdown = async () => {
    await bot.stop();
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
