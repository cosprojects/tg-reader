// Проверка транспорта вебхука: маршрут /telegram/webhook на нашем HTTP-сервере,
// проверка секретного заголовка и то, что остальные ручки API не задеты.
// Запуск: node server/test-webhook.mjs
//
// Telegram не задействован: Bot API подменён fetch-заглушкой, апдейты приходят настоящим
// HTTP-запросом на поднятый сервер. Синтез подменён, чтобы проверка была быстрой.
import { webhookCallback } from 'grammy';
import { loadEnv } from './src/env.js';
import { startApi } from './src/api.js';
import { createBot } from './src/bot.js';
import { readTtsConfig } from './src/tts.js';

const TOKEN = '123456789:AAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINI_APP = 'https://telegram-reader-eight.vercel.app';
const SECRET = 'secret-token-for-test-123';
const PATH_WEBHOOK = '/telegram/webhook';
const PORT = 3321;
const USER = { id: 42, is_bot: false, first_name: 'Тест' };
const CHAT = { id: 42, type: 'private', first_name: 'Тест' };

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

function fakeBotInfo() {
  return {
    id: 123456789,
    is_bot: true,
    first_name: 'Reader',
    username: 'itsvoiceoverbot_test',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
}

function createFakeApi(log) {
  return async (url, init = {}) => {
    const method = String(url).split('/').pop().split('?')[0];
    const payload = init.body ? JSON.parse(init.body) : {};
    log.push({ method, payload });

    let result = true;
    if (method === 'getMe') result = fakeBotInfo();
    if (method === 'sendMessage') {
      result = { message_id: log.filter((item) => item.method === 'sendMessage').length, date: 0, chat: CHAT, text: payload.text };
    }

    return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => JSON.stringify({ ok: true, result }) };
  };
}

function postUpdate(text) {
  return {
    update_id: 1,
    message: { message_id: 500, from: USER, chat: CHAT, date: 0, text },
  };
}

function post(body, { secret = SECRET, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return fetch(`http://localhost:${PORT}${PATH_WEBHOOK}`, {
    method: 'POST',
    headers,
    body: raw ? body : JSON.stringify(body),
  });
}

async function main() {
  loadEnv();

  const log = [];
  const errors = [];
  const { bot } = createBot({
    token: TOKEN,
    miniAppUrl: MINI_APP,
    config: readTtsConfig(),
    onError: (message) => errors.push(String(message)),
    client: { fetch: createFakeApi(log) },
    // Синтез подменён: проверяется транспорт, а не Silero.
    generate: async () => ({ chunks: 1, cached: false }),
  });

  const handler = webhookCallback(bot, 'http', { secretToken: SECRET, timeoutMilliseconds: 5000 });
  const server = startApi({ port: PORT, webhook: { path: PATH_WEBHOOK, handler } });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    // 1. Верный секрет: апдейт доходит до обработчиков бота.
    const ok = await post(postUpdate('Пост для проверки вебхука.'));
    check('апдейт с верным секретом принят', ok.status === 200, `HTTP ${ok.status}`);
    const replied = log.find((item) => item.method === 'sendMessage' && /Готовим озвучку|Пост добавлен/.test(item.payload.text ?? ''));
    check('бот обработал апдейт и ответил статусом', Boolean(replied), replied ? replied.payload.text : `вызовов sendMessage: ${log.filter((i) => i.method === 'sendMessage').length}`);

    // 2. Чужой запрос без секрета и с неверным секретом не должен доходить до бота.
    const before = log.filter((item) => item.method === 'sendMessage').length;
    const wrong = await post(postUpdate('Пост от чужого.'), { secret: 'wrong-secret-token' });
    const none = await post(postUpdate('Пост без секрета.'), { secret: null });
    check('неверный секрет отклонён', wrong.status === 401, `HTTP ${wrong.status}`);
    check('отсутствующий секрет отклонён', none.status === 401, `HTTP ${none.status}`);
    check(
      'отклонённые запросы не дошли до бота',
      log.filter((item) => item.method === 'sendMessage').length === before,
      `sendMessage: ${before} → ${log.filter((i) => i.method === 'sendMessage').length}`,
    );

    // 3. Метод на маршруте вебхука: Telegram присылает только POST.
    const wrongMethod = await fetch(`http://localhost:${PORT}${PATH_WEBHOOK}`, { method: 'GET' });
    check('GET на маршрут вебхука отвечает 405', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`);

    // 4. Остальные ручки API продолжают работать на том же сервере.
    const health = await fetch(`http://localhost:${PORT}/api/health`);
    const healthBody = await health.json();
    check('GET /api/health отвечает 200', health.status === 200, `HTTP ${health.status}`);
    check('в health есть состояние TTS', healthBody?.tts?.provider === 'silero', JSON.stringify(healthBody?.tts));

    const missing = await fetch(`http://localhost:${PORT}/api/no-such-route`);
    check('неизвестный путь отвечает 404', missing.status === 404, `HTTP ${missing.status}`);

    // 5. Битое тело не должно ронять сервер: Telegram такое не присылает, но падать нельзя.
    const broken = await post('{это не json', { raw: true });
    check('битое тело не роняет сервер', broken.status >= 400, `HTTP ${broken.status}`);
    const after = await post(postUpdate('Пост после битого тела.'));
    check('после битого тела апдейты принимаются', after.status === 200, `HTTP ${after.status}`);

    check('ошибок обработки не было', errors.length === 0, errors.join('; '));
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
