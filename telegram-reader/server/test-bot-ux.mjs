// Проверка UX бота: /start, /reset, «⏹ Остановить», меню команд и согласованность состояния.
// Запуск: node server/test-bot-ux.mjs
//
// Telegram здесь не задействован: Bot API подменён на fetch-заглушку, а апдейты подаются
// через bot.handleUpdate — обработчики выполняются настоящие. Синтез в первой части тоже
// подменён (проверяется логика состояния), во второй части работает настоящий Silero:
// там проверяется, что «Остановить» реально прерывает синтез и не пишет аудио в кэш.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from './src/env.js';
import { createBot, COMMANDS, isValidToken } from './src/bot.js';
import { cacheDir, readManifest } from './src/audio-store.js';
import { countPosts, getPost, postsOfUser } from './src/store.js';
import { generateAudioForPost } from './src/generate.js';
import { isTtsConfigured, readTtsConfig, resolveVoiceForProvider, synthesize } from './src/tts.js';

const TOKEN = '123456789:AAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINI_APP = 'https://telegram-reader-eight.vercel.app';
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

// --- заглушка Bot API -------------------------------------------------------------------

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

// --- апдейты ----------------------------------------------------------------------------

let updateId = 1;
let messageId = 100;

function commandUpdate(command, { chat = CHAT, from = USER } = {}) {
  const text = `/${command}`;
  return {
    update_id: updateId++,
    message: {
      message_id: messageId++,
      from,
      chat,
      date: 0,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  };
}

function postUpdate(text, { chat = CHAT, from = USER, forward = true, forwardOrigin = null, messageId: id = null } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: id ?? messageId++,
      from,
      chat,
      date: 0,
      text,
      ...(forward
        ? { forward_origin: forwardOrigin ?? { type: 'user', date: 0, sender_user: { id: 7, is_bot: false, first_name: 'Канал' } } }
        : {}),
    },
  };
}

// Фото без подписи: текста в сообщении нет.
function photoUpdate({ chat = CHAT, from = USER } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: messageId++,
      from,
      chat,
      date: 0,
      photo: [{ file_id: 'photo-1', file_unique_id: 'u1', width: 100, height: 100 }],
    },
  };
}

function callbackUpdate(data, { messageId: id = 1, chat = CHAT, from = USER } = {}) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from,
      chat_instance: 'test',
      data,
      message: { message_id: id, date: 0, chat, text: 'сообщение с кнопкой' },
    },
  };
}

// --- подменённый синтез -----------------------------------------------------------------

// Заглушка вместо Silero: операция не завершается, пока тест не вызовет finish(),
// поэтому можно проверить и «Остановить», и «аудио готово», и очередь.
function createFakeGenerator() {
  const calls = [];

  return {
    calls,
    async run(userId, postId, { signal, onProgress }) {
      onProgress?.({ chunk: 1, chunks: 2 });

      const entry = { userId, postId, aborted: false, finished: false };
      calls.push(entry);

      await new Promise((resolve, reject) => {
        entry.finish = () => {
          entry.finished = true;
          resolve();
        };
        signal.addEventListener('abort', () => {
          entry.aborted = true;
          const error = new Error('синтез прерван');
          error.name = 'AbortError';
          error.code = 'tts_cancelled';
          reject(error);
        });
      });

      return { chunks: 2, cached: false };
    },
  };
}

const lastOf = (log, method) => [...log].reverse().find((item) => item.method === method);
const lastText = (log, method) => lastOf(log, method)?.payload?.text ?? '';
const textsOf = (log, method) => log.filter((item) => item.method === method).map((item) => String(item.payload.text ?? ''));

function keyboardOf(call) {
  return call?.payload?.reply_markup?.inline_keyboard ?? null;
}

// Бот не прикладывает клавиатуры к сообщениям: кнопки живут в меню у поля ввода.
function markupOf(call) {
  return call?.payload?.reply_markup ?? null;
}

// Id поста в сообщении больше не показывается: смотрим последний пост пользователя.
function lastPostId(userId = USER.id) {
  return postsOfUser(userId).at(-1)?.id ?? null;
}

// --- часть 1: состояние и команды -------------------------------------------------------

async function testHandlers() {
  console.log('\n— /start, /reset, кнопки (синтез подменён) —');

  const log = [];
  const errors = [];
  const logs = [];
  const generator = createFakeGenerator();
  const config = readTtsConfig();

  const { bot, queue, commandsReady } = createBot({
    token: TOKEN,
    miniAppUrl: MINI_APP,
    config,
    generate: generator.run,
    onError: (message) => errors.push(String(message)),
    onLog: (message) => logs.push(String(message)),
    client: { fetch: createFakeApi(log) },
  });

  await commandsReady;
  // getMe уходит в ту же заглушку: инициализация нужна handleUpdate.
  await bot.init();
  await settle(2);

  const commandsCall = lastOf(log, 'setMyCommands');
  check('меню команд отправлено через setMyCommands', Boolean(commandsCall));
  check(
    'в меню три команды: запустить, сбросить всё, объяснение',
    JSON.stringify(commandsCall?.payload.commands) ===
      JSON.stringify([
        { command: 'start', description: '🚀 Запустить' },
        { command: 'reset', description: '🧹 Сбросить всё' },
        { command: 'help', description: '❓ Как это работает?' },
      ]),
    JSON.stringify(commandsCall?.payload.commands),
  );

  check('меню ограничено личными чатами', commandsCall?.payload.scope?.type === 'all_private_chats');
  check(
    'кнопка меню чата открывает Mini App',
    lastOf(log, 'setChatMenuButton')?.payload?.menu_button?.type === 'web_app',
    JSON.stringify(lastOf(log, 'setChatMenuButton')?.payload),
  );
  check('COMMANDS экспортирует то же меню', JSON.stringify(COMMANDS) === JSON.stringify(commandsCall?.payload.commands));

  // A. /start на чистом состоянии.
  await bot.handleUpdate(commandUpdate('start'));
  await settle(2);
  const startCall = lastOf(log, 'sendMessage');
  check('/start приветствует и объясняет сценарий', /Post Reader/.test(startCall.payload.text) && /Mini App/.test(startCall.payload.text), startCall.payload.text.slice(0, 80));
  check('/start рассказывает порядок действий', /Перешли мне пост/.test(startCall.payload.text), startCall.payload.text.slice(0, 120));
  check(
    '/start показывает ряд кнопок под полем ввода',
    markupOf(startCall)?.keyboard?.[0]?.[0]?.text === '🚀 Старт' && markupOf(startCall)?.keyboard?.[0]?.[1]?.text === '❓ Как это работает?',
    JSON.stringify(markupOf(startCall)),
  );
  check('без постов кнопки «Очистить плейлист» нет', !JSON.stringify(markupOf(startCall)?.keyboard ?? []).includes('Очистить плейлист'));

  // B. Пост: ответ с клавиатурой и старт синтеза.
  const postsBefore = countPosts();
  await bot.handleUpdate(postUpdate('Первый пост про 2026 год. Компания выросла на 15%.'));
  await settle(3);

  // Статус поста: после него бот может отправить подсказку с рядом кнопок.
  const postCall = [...log].reverse().find((item) => item.method === 'sendMessage' && /Готовим озвучку|Пост добавлен/.test(item.payload.text ?? ''));
  const postKeyboard = keyboardOf(postCall);
  check('на пост бот отвечает коротким статусом', /Готовим озвучку/.test(postCall.payload.text), postCall.payload.text);
  check('под постом тоже нет клавиатуры', postCall.payload.reply_markup === undefined, JSON.stringify(postCall.payload.reply_markup));
  check('синтез запущен сразу после поста', generator.calls.length === 1);
  check('пост сохранён', countPosts() === postsBefore + 1);

  const firstPostId = lastPostId();
  check('пост сохранён за своим пользователем', getPost(firstPostId)?.userId === String(USER.id), String(getPost(firstPostId)?.userId));

  // Статус поста обновляется по мере синтеза.
  await settle(3);
  const runningText = lastText(log, 'editMessageText');
  // Первое сообщение уже показывает «Готовим озвучку…», поэтому повторной правки нет.
  check('во время синтеза статус «Готовим озвучку…»', /Готовим озвучку/.test(postCall.payload.text), postCall.payload.text);
  // Номер части в статусе — это прогресс, он нужен; id поста и число символов — нет.
  check('служебные подробности в статус не попадают', !/id: |символов: /.test(runningText ?? ''), String(runningText));

  // C. Завершение синтеза: кнопка «Остановить» пропадает.
  generator.calls[0].finish();
  await settle(4);
  // Правки статуса не передают клавиатуру: Telegram сохраняет ту, что была в сообщении.
  const readyKeyboard = keyboardOf(lastOf(log, 'editMessageText'));
  check('после синтеза сообщение говорит «Озвучка готова»', /Озвучка готова/.test(lastText(log, 'editMessageText')), lastText(log, 'editMessageText'));
  check('правки статуса не прикладывают клавиатуру', readyKeyboard === null, JSON.stringify(readyKeyboard));

  // D. /start с накопленным постом ничего не удаляет.
  const postsAfterPost = countPosts();
  await bot.handleUpdate(commandUpdate('start'));
  await settle(2);
  const startAgain = lastOf(log, 'sendMessage');
  check('/start повторяет текущее состояние', /Озвучка готова/.test(startAgain.payload.text), startAgain.payload.text.slice(-60));
  check('/start не удаляет посты', countPosts() === postsAfterPost);
  check('после постов появляется кнопка «Очистить плейлист»', JSON.stringify(markupOf(startAgain)?.keyboard ?? []).includes('Очистить плейлист'), JSON.stringify(markupOf(startAgain)?.keyboard));

  // E. Неизвестная команда не превращается в пост.
  await bot.handleUpdate(commandUpdate('unknown'));
  await settle(2);
  check('неизвестная команда не сохраняется как пост', countPosts() === postsAfterPost);
  check('бот подсказывает, что делать', /Пришли пост из Telegram/.test(lastOf(log, 'sendMessage').payload.text) && /\/open, \/reset, \/help/.test(lastOf(log, 'sendMessage').payload.text), lastOf(log, 'sendMessage').payload.text);

  // F. Пост, остановка, новый пост.
  await bot.handleUpdate(postUpdate('Второй пост: 2024 год и 3.14.'));
  await settle(3);
  const second = generator.calls[1];
  check('второй пост начал синтез', Boolean(second));

  await bot.handleUpdate(callbackUpdate(`stop:${second.postId}`));
  await settle(4);
  check('на «Остановить» синтез получил отмену', second.aborted);
  check('на «Остановить» ответ в callback', /Остановлено/.test(lastOf(log, 'answerCallbackQuery').payload.text));
  check('сообщение перешло в «Остановлено»', /⏹ Остановлено/.test(lastText(log, 'editMessageText')), lastText(log, 'editMessageText'));

  generator.calls[1].finish();
  await settle(4);
  check('после отмены результат не показывается как готовый', !/Озвучка готова/.test(textsOf(log, 'editMessageText').at(-1)));
  check('состояние не залипает на «Готовим озвучку»', !/Готовим озвучку/.test(textsOf(log, 'editMessageText').at(-1)));
  check('пользователь не считается занятым', queue.isRunning(USER.id) === false);

  // G. После остановки новый пост обрабатывается нормально.
  await bot.handleUpdate(postUpdate('Третий пост: 2025 год, 20 долларов.'));
  await settle(3);
  const third = generator.calls[2];
  check('после остановки синтез запускается снова', Boolean(third) && third.postId !== second.postId);
  third.finish();
  await settle(4);
  check('третий пост дошёл до «Озвучка готова»', /Озвучка готова/.test(lastText(log, 'editMessageText')));

  // H. Кнопка старого поста не останавливает текущую операцию.
  await bot.handleUpdate(postUpdate('Четвёртый пост для проверки устаревшей кнопки.'));
  await settle(3);
  const fourth = generator.calls[3];
  await bot.handleUpdate(callbackUpdate(`stop:${second.postId}`));
  await settle(3);
  check('устаревшая кнопка не трогает текущий синтез', fourth.aborted === false);
  check('устаревшая кнопка отвечает понятно', /уже завершена/.test(lastOf(log, 'answerCallbackQuery').payload.text));

  // I. /reset во время синтеза.
  await bot.handleUpdate(commandUpdate('reset'));
  await settle(4);
  const resetCall = lastOf(log, 'sendMessage');
  check('«/reset» подтверждает полный сброс', resetCall.payload.text.startsWith('🧹 Всё сброшено. Можешь прислать новые посты.'), resetCall.payload.text);
  check('«/reset» прерывает текущий синтез', fourth.aborted === true);
  check('«/reset» сообщает, что озвучка остановлена', /текущая озвучка остановлена/.test(resetCall.payload.text), resetCall.payload.text);
  check('«/reset» удаляет посты пользователя', countPosts() === 0);
  check('после «/reset» состояние пользователя пустое', queue.isRunning(USER.id) === false);

  const beforeResetFinalize = textsOf(log, 'editMessageText');
  await settle(4);
  check(
    'прерванная операция не правит сообщение после сброса',
    textsOf(log, 'editMessageText').length === beforeResetFinalize.length,
    `было ${beforeResetFinalize.length}, стало ${textsOf(log, 'editMessageText').length}`,
  );
  check('сообщение о прерванной операции помечено очисткой', /Плейлист очищен \(\/reset\)/.test(beforeResetFinalize.at(-1)), beforeResetFinalize.at(-1));
  check(
    'у сброшенного сообщения нет inline-кнопок',
    (lastOf(log, 'editMessageText').payload.reply_markup?.inline_keyboard ?? null) === null,
    JSON.stringify(lastOf(log, 'editMessageText').payload.reply_markup),
  );

  // J. /reset без активной операции и кнопкой.
  // Кнопка «🧹 Очистить плейлист»: полный сброс с удалением сообщений бота.
  await bot.handleUpdate(postUpdate('🧹 Очистить плейлист', { forward: false }));
  await settle(4);
  const resetText = lastOf(log, 'sendMessage').payload.text;
  check('кнопка «Очистить плейлист» подтверждает полный сброс', /Всё сброшено/.test(resetText), resetText);
  check('сброс убирает посты пользователя', countPosts() === 0, `постов: ${countPosts()}`);
  check('сброс удаляет сообщения бота из чата', log.filter((item) => item.method === 'deleteMessage').length > 0, `deleteMessage: ${log.filter((item) => item.method === 'deleteMessage').length}`);
  check('после сброса кнопки «Очистить плейлист» нет', !JSON.stringify(lastOf(log, 'sendMessage').payload.reply_markup?.keyboard ?? []).includes('Очистить плейлист'));

  // Кнопки «🚀 Старт» и «📮 Связаться» тоже обрабатываются как текст.
  await bot.handleUpdate(postUpdate('🚀 Старт', { forward: false }));
  await settle(2);
  check('кнопка «Старт» показывает интерфейс', /Как это работает/.test(lastOf(log, 'sendMessage').payload.text), lastOf(log, 'sendMessage').payload.text);

  await bot.handleUpdate(postUpdate('📮 Связаться', { forward: false }));
  await settle(2);
  check('без адреса кнопка «Связаться» честно об этом пишет', /Адрес для связи пока не задан/.test(lastOf(log, 'sendMessage').payload.text), lastOf(log, 'sendMessage').payload.text);

  await bot.handleUpdate(callbackUpdate('stop'));
  await settle(2);
  check('«Остановить» без операции отвечает без ошибки', /нечего останавливать/.test(lastOf(log, 'answerCallbackQuery').payload.text), lastOf(log, 'answerCallbackQuery').payload.text);

  await bot.handleUpdate(callbackUpdate('legacy-button'));
  await settle(2);
  check('неизвестная кнопка тоже получает ответ', /устарела/.test(lastOf(log, 'answerCallbackQuery').payload.text));

  // J2. Кнопка «Остановить» нижней клавиатуры (приходит как текст).
  await bot.handleUpdate(postUpdate('Пост для проверки кнопки остановки.', { forward: true, messageId: 700 }));
  await settle(3);
  const stoppable = generator.calls.at(-1);
  await bot.handleUpdate(callbackUpdate('stop'));
  await settle(4);
  check('команда остановки прерывает текущий синтез', stoppable.aborted === true);
  check('сообщение переходит в «Остановлено»', /Остановлено/.test(lastText(log, 'editMessageText')), lastText(log, 'editMessageText'));

  // J3. Дубликаты: та же пересылка из канала не создаёт новый пост.
  const beforeDuplicate = countPosts();
  const forward = { type: 'channel', date: 0, message_id: 4242, chat: { id: -100500, type: 'channel', title: 'Канал' } };
  await bot.handleUpdate(postUpdate('Пост из канала про AI.', { forward: true, forwardOrigin: forward, messageId: 800 }));
  await settle(3);
  const afterFirst = countPosts();
  await bot.handleUpdate(postUpdate('Пост из канала про AI.', { forward: true, forwardOrigin: forward, messageId: 801 }));
  await settle(3);
  check('первая пересылка создаёт пост', afterFirst === beforeDuplicate + 1, `${beforeDuplicate} → ${afterFirst}`);
  check('повторная пересылка того же поста не создаёт запись', countPosts() === afterFirst, `постов: ${countPosts()}`);
  check('на дубликат бот отвечает «Этот пост уже в очереди»', /Этот пост уже в очереди/.test(lastOf(log, 'sendMessage').payload.text), lastOf(log, 'sendMessage').payload.text);

  // J4. Медиа без подписи: бот объясняет, что нужен текст.
  await bot.handleUpdate(photoUpdate());
  await settle(2);
  check('медиа без подписи получает объяснение', /нужен текст или подпись/.test(lastOf(log, 'sendMessage').payload.text), lastOf(log, 'sendMessage').payload.text);

  // K. Личные чаты: в группе бот не создаёт постов.
  const beforeGroup = countPosts();
  await bot.handleUpdate(postUpdate('Пост в группе', { chat: { id: -100, type: 'group', title: 'Группа' }, forward: false }));
  await settle(2);
  check('в группе пост не принимается', countPosts() === beforeGroup, `${beforeGroup} → ${countPosts()}`);
  check('в группе бот объясняет про личный чат', /личный чат/.test(lastOf(log, 'sendMessage').payload.text));

  // L. Обработчики не регистрируются повторно.
  const middlewareBefore = bot.middleware().length;
  await bot.handleUpdate(postUpdate('Пятый пост.'));
  await settle(2);
  await bot.handleUpdate(commandUpdate('start'));
  await bot.handleUpdate(callbackUpdate('stop'));
  await settle(3);
  check('число обработчиков не растёт от апдейтов', bot.middleware().length === middlewareBefore, `${middlewareBefore} → ${bot.middleware().length}`);
  check('setMyCommands вызывается один раз за запуск', log.filter((item) => item.method === 'setMyCommands').length === 1);
  check('логируется факт обновления меню команд', logs.some((line) => /меню команд/.test(line)));

  check('ошибок обработки не было', errors.length === 0, errors.join('; '));

  generator.calls.at(-1)?.finish();
  await settle(2);
  queue.clear(USER.id);
}

// --- часть 2: настоящая отмена Silero ---------------------------------------------------

const LONG_TEXT = [
  'Это проверка отмены синтеза на настоящей модели. Текст специально длинный, чтобы синтез не успел завершиться за пару секунд.',
  'Silero читает части по очереди, и остановка должна прервать ту часть, которая выполняется сейчас, а не дождаться её конца.',
  'В кэш после отмены не должно попасть ничего: следующий запрос обязан начать синтез заново, а не отдать недосчитанное аудио.',
].join(' ');

// Отмена взводится, пока синтез идёт: python грузит модель около секунды даже на быстрой
// машине, поэтому 300 мс попадают внутрь работы. Привязать отмену к длине текста нельзя —
// на быстрой машине часть успевает досчитаться, и тест начинал падать на ровном месте.
const CANCEL_DELAY_MS = 300;

// Текст для сценария «пост → стоп → новый пост»: две части по пределу модели.
// Одной части мало — остановка может прийтись на момент, когда синтез уже дописан,
// и тогда аудио честно ложится в кэш, а проверка «отменённый пост не оставил каталога» падает.
const BOT_FLOW_TEXT = `${LONG_TEXT} ${LONG_TEXT}`;

function tempSileroDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('tg-reader-silero-'));
}

async function testRealCancellation() {
  console.log('\n— «Остановить» на настоящем Silero —');

  const config = readTtsConfig();

  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен в этом окружении');
    return;
  }

  const provider = 'silero';
  const voice = await resolveVoiceForProvider(config, provider, undefined);
  const post = { id: randomUUID(), text: LONG_TEXT };
  const dirsBefore = tempSileroDirs().length;

  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), CANCEL_DELAY_MS);

  let error = null;
  try {
    await generateAudioForPost(config, post, { provider, voice, signal: controller.signal });
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
  }
  const elapsed = Date.now() - startedAt;

  check('отмена прерывает синтез Silero', error?.code === 'tts_cancelled', `${error?.name}: ${error?.message}`);
  check('отмена срабатывает быстро, не дожидаясь конца части', elapsed < 20_000, `${elapsed} мс`);
  check('после отмены аудио для поста не сохранено', (await readManifest(post.id, provider, voice)) === null);
  await settle(2);
  check('временные файлы синтеза убраны', tempSileroDirs().length <= dirsBefore, `${dirsBefore} → ${tempSileroDirs().length}`);

  // Тот же путь после отмены работает заново: прерванный синтез не ломает следующие запуски.
  const controller2 = new AbortController();
  const startedAt2 = Date.now();
  const timer2 = setTimeout(() => controller2.abort(), 120_000);
  let secondError = null;
  try {
    await synthesize(config, 'Короткая проверка после отмены.', { provider, voice, signal: controller2.signal });
  } catch (caught) {
    secondError = caught;
  } finally {
    clearTimeout(timer2);
  }
  check('синтез можно запустить снова после отмены', secondError === null, `${secondError?.name}: ${secondError?.message}`);
  console.log(`  (полный синтез короткого текста: ${Date.now() - startedAt2} мс)`);
}

// --- часть 3: бот целиком на настоящем Silero -------------------------------------------

// Тот же сценарий, что в Telegram: пост → синтез идёт → «⏹ Остановить» → синтез прерван,
// аудио не сохранено → следующий пост доходит до «Аудио готово» и попадает в кэш.
async function testRealBotFlow() {
  console.log('\n— бот на настоящем Silero: пост → стоп → новый пост —');

  const config = readTtsConfig();
  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен в этом окружении');
    return;
  }

  const user = { id: 77, is_bot: false, first_name: 'Тест' };
  const chat = { id: 77, type: 'private', first_name: 'Тест' };
  const log = [];
  const errors = [];
  const voice = await resolveVoiceForProvider(config, 'silero', undefined);

  // generate не подменяем: работает настоящий Silero через тот же путь, что и в боте.
  const { bot, queue } = createBot({
    token: TOKEN,
    miniAppUrl: MINI_APP,
    config,
    onError: (message) => errors.push(String(message)),
    client: { fetch: createFakeApi(log) },
  });
  await bot.init();

  await bot.handleUpdate(postUpdate(BOT_FLOW_TEXT, { chat, from: user }));
  await settle(2);
  // Статус поста: после него бот может отправить подсказку с рядом кнопок.
  const postCall = [...log].reverse().find((item) => item.method === 'sendMessage' && /Готовим озвучку|Пост добавлен/.test(item.payload.text ?? ''));
  check('на пост сразу показан статус «Готовим озвучку…»', /Готовим озвучку/.test(postCall.payload.text), postCall.payload.text);
  check('операция считается активной', queue.isRunning(user.id) === true);

  const cancelledPostId = lastPostId(user.id);
  const cacheBefore = readdirSync(cacheDir());
  await settle(50); // даём синтезу реально начаться

  await bot.handleUpdate(callbackUpdate(`stop:${cancelledPostId}`, { chat, from: user }));
  await settle(30);
  check('после «Остановить» сообщение говорит «Остановлено»', /⏹ Остановлено/.test(lastText(log, 'editMessageText')), lastText(log, 'editMessageText'));
  check('после «Остановить» операция больше не активна', queue.isRunning(user.id) === false);
  check('после «Остановить» аудио не сохранено', (await readManifest(cancelledPostId, 'silero', voice)) === null);

  // Новый пост после остановки проходит весь путь до готового аудио.
  await bot.handleUpdate(postUpdate('Проверка после остановки: 2026 год, 15%.', { chat, from: user }));
  const readyPostId = lastPostId(user.id);

  let ready = false;
  for (let i = 0; i < 600 && !ready; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    ready = /Озвучка готова/.test(lastText(log, 'editMessageText'));
  }
  check('новый пост после остановки доходит до «Озвучка готова»', ready, lastText(log, 'editMessageText'));

  const manifest = await readManifest(readyPostId, 'silero', voice);
  check('готовое аудио лежит в кэше', Boolean(manifest?.chunks?.length), `postId=${readyPostId}`);
  void postCall;
  check('ошибок в этом сценарии не было', errors.length === 0, errors.join('; '));

  // Кэш — рабочий каталог проекта, в нём могут лежать каталоги других прогонов.
  // Поэтому проверяем ровно тот пост, который отменили, а не «весь каталог не изменился»:
  // сравнение всего содержимого ловило чужие записи и падало не по делу.
  const cancelledDir = path.join(cacheDir(), cancelledPostId);
  check('отменённый пост не оставил каталога в кэше', !existsSync(cancelledDir), `postId=${cancelledPostId}`);

  // Уборка за собой: только то, что создал этот прогон.
  rmSync(cancelledDir, { recursive: true, force: true });
  rmSync(path.join(cacheDir(), readyPostId), { recursive: true, force: true });
}

async function main() {
  // .env читаем как настоящий сервер (нужны TTS_SILERO_*), но BOT_TOKEN нигде не используется:
  // запросы к Telegram идут в заглушку fetch.
  loadEnv();

  check('токен-заглушка проходит проверку формата', isValidToken(TOKEN));
  await testHandlers();
  await testRealCancellation();
  await testRealBotFlow();

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
