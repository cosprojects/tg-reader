// Проверка извлечения текста поста: node server/test-post-text.mjs
//
// Telegram не задействован: апдейты подаются через bot.handleUpdate, а Bot API подменён
// fetch-заглушкой. Три части:
//   1. сам extractPostText на сообщениях разного типа (случаи A–E и детали подписи);
//   2. настоящий обработчик бота: текст, фото+подпись, видео+подпись, медиа без подписи;
//   3. случай F с настоящим Silero: подпись с числами, латиницей, URL и эмодзи
//      проходит весь pipeline и попадает в кэш.
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from './src/env.js';
import { createBot } from './src/bot.js';
import { cacheDir, readManifest } from './src/audio-store.js';
import { countPosts, getPost, postsOfUser } from './src/store.js';
import { describePost, extractPostText, messageKind } from './src/post-text.js';
import { describePreparation, isTtsConfigured, readTtsConfig, resolveVoiceForProvider } from './src/tts.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

const TOKEN = '123456789:AAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINI_APP = 'https://telegram-reader-eight.vercel.app';
const USER = { id: 42, is_bot: false, first_name: 'Тест' };
const CHAT = { id: 42, type: 'private', first_name: 'Тест' };

const photo = [{ file_id: 'photo-1', file_unique_id: 'u1', width: 1280, height: 720 }];
const video = { file_id: 'video-1', file_unique_id: 'u2', width: 1280, height: 720, duration: 12 };

const CAPTION = [
  'Мы используем OpenAI API в 2026 году.',
  'Подробнее: https://example.com',
].join('\n');

// --- часть 1: extractPostText ------------------------------------------------------------

function testExtractor() {
  console.log('\n— extractPostText на сообщениях Telegram —');

  const textOnly = { message_id: 1, date: 0, text: 'Обычный пост про 2026 год.' };
  const photoWithCaption = { message_id: 2, date: 0, photo, caption: CAPTION };
  const videoWithCaption = { message_id: 3, date: 0, video, caption: 'Подпись к видео с AI.' };
  const photoOnly = { message_id: 4, date: 0, photo };
  const videoOnly = { message_id: 5, date: 0, video };

  // A, B, C.
  const a = extractPostText(textOnly);
  check('A: текст → source=text', a.source === 'text' && a.type === 'text' && a.text === textOnly.text, JSON.stringify(a));

  const b = extractPostText(photoWithCaption);
  check('B: фото + подпись → source=caption', b.source === 'caption' && b.type === 'photo' && b.text === CAPTION, JSON.stringify(b));

  const c = extractPostText(videoWithCaption);
  check('C: видео + подпись → source=caption', c.source === 'caption' && c.type === 'video' && c.text === 'Подпись к видео с AI.', JSON.stringify(c));

  // D, E.
  const d = extractPostText(photoOnly);
  check('D: только фото → текста нет', d.source === 'none' && d.type === 'photo' && d.text === '', JSON.stringify(d));

  const e = extractPostText(videoOnly);
  check('E: только видео → текста нет', e.source === 'none' && e.type === 'video' && e.text === '', JSON.stringify(e));

  // Другие медиа с подписью берутся так же: Telegram отдаёт caption для всех них.
  for (const [field, value, type] of [
    ['animation', { file_id: 'a' }, 'animation'],
    ['document', { file_id: 'd' }, 'document'],
    ['audio', { file_id: 's' }, 'audio'],
  ]) {
    const message = { message_id: 6, date: 0, [field]: value, caption: 'Подпись' };
    const result = extractPostText(message);
    check(`${type} + подпись → source=caption`, result.source === 'caption' && result.type === type && result.text === 'Подпись', JSON.stringify(result));
  }

  // Без подписи у этих типов брать нечего.
  for (const [field, value, type] of [
    ['voice', { file_id: 'v' }, 'voice'],
    ['sticker', { file_id: 'st' }, 'sticker'],
    ['video_note', { file_id: 'vn' }, 'video_note'],
  ]) {
    const result = extractPostText({ message_id: 7, date: 0, [field]: value });
    check(`${type} без подписи → текста нет`, result.source === 'none' && result.type === type, JSON.stringify(result));
  }

  // Пустая и пробельная подпись не считается текстом.
  check('пустая подпись не превращается в пост', extractPostText({ message_id: 8, date: 0, photo, caption: '   \n  ' }).source === 'none');
  check('пустой text не превращается в пост', extractPostText({ message_id: 9, date: 0, text: '' }).source === 'none');

  // Подпись сохраняется целиком: абзацы, ссылки, латиница, числа, эмодзи.
  const rich = 'Первый абзац с AI и 15%.\n\nВторой абзац: https://example.com 🙌\n#тег @durov';
  const richResult = extractPostText({ message_id: 10, date: 0, photo, caption: rich });
  check('подпись сохраняется целиком', richResult.text === rich, JSON.stringify(richResult.text));
  check('абзацы в подписи не схлопываются', richResult.text.includes('\n\n'));
  check('ссылка, латиница, эмодзи и упоминание на месте', /https:\/\/example\.com/.test(richResult.text) && /AI/.test(richResult.text) && /🙌/.test(richResult.text) && /@durov/.test(richResult.text));

  // Служебные сообщения не логируем, остальные — да, в оговорённом формате.
  check('текст: формат лога', describePost(textOnly) === `[post] type=text textSource=text textLength=${textOnly.text.length}`, String(describePost(textOnly)));
  check('фото + подпись: формат лога', describePost(photoWithCaption) === `[post] type=photo textSource=caption textLength=${CAPTION.length}`, String(describePost(photoWithCaption)));
  check('фото без подписи: формат лога', describePost(photoOnly) === '[post] type=photo textSource=none → skipped', String(describePost(photoOnly)));
  check('служебное сообщение не логируется', describePost({ message_id: 11, date: 0, pinned_message: {} }) === null);
  check('тип служебного сообщения — other', messageKind({ message_id: 12, date: 0, new_chat_title: 'x' }) === 'other');
}

// --- часть 2: обработчик бота ------------------------------------------------------------

function createFakeApi(log) {
  return async (url, init = {}) => {
    const method = String(url).split('/').pop().split('?')[0];
    const payload = init.body ? JSON.parse(init.body) : {};
    log.push({ method, payload });

    let result = true;
    if (method === 'getMe') {
      result = {
        id: 1, is_bot: true, first_name: 'Reader', username: 'test_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      };
    }
    if (method === 'sendMessage') result = { message_id: log.filter((item) => item.method === 'sendMessage').length, date: 0, chat: CHAT, text: payload.text };

    return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => JSON.stringify({ ok: true, result }) };
  };
}

let updateId = 1;
let messageId = 100;

function update(extra, { chat = CHAT } = {}) {
  return { update_id: updateId++, message: { message_id: messageId++, from: USER, chat, date: 0, ...extra } };
}

const lastSend = (log) => [...log].reverse().find((item) => item.method === 'sendMessage');
// Сообщение со статусом поста: после него бот может отправить подсказку с клавиатурой.
const statusSend = (log) =>
  [...log].reverse().find((item) => item.method === 'sendMessage' && /Готовим озвучку|Пост добавлен|Озвучка готова/.test(item.payload.text ?? ''));
const keyboardOf = (call) => call?.payload?.reply_markup?.inline_keyboard ?? null;
// Id поста в сообщении не показывается: смотрим последний пост пользователя в хранилище.
const lastPostOf = (userId) => postsOfUser(userId).at(-1) ?? null;

async function testHandler() {
  console.log('\n— обработчик бота: текст и медиа —');

  const log = [];
  const errors = [];
  const logs = [];
  const generated = [];

  const { bot } = createBot({
    token: TOKEN,
    miniAppUrl: MINI_APP,
    config: readTtsConfig(),
    onError: (message) => errors.push(String(message)),
    onLog: (message) => logs.push(String(message)),
    client: { fetch: createFakeApi(log) },
    // Синтез подменён: проверяем, что пост доходит до очереди, а не работу Silero.
    generate: async (userId, postId) => {
      generated.push({ userId, postId });
      return { chunks: 1, cached: false };
    },
  });

  await bot.init();

  // A: обычный текст.
  const postsBefore = countPosts();
  await bot.handleUpdate(update({ text: 'Обычный пост про 2026 год.' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const textCall = statusSend(log);
  check('A: текст → пост создан', countPosts() === postsBefore + 1, `постов: ${countPosts()}`);
  check('A: короткий статус синтеза', /Готовим озвучку/.test(textCall.payload.text), textCall.payload.text);
  check('A: к статусу клавиатура не приложена', textCall.payload.reply_markup === undefined, JSON.stringify(textCall.payload.reply_markup));
  const hintCall = lastSend(log);
  check(
    'A: ряд кнопок приходит отдельным сообщением',
    hintCall.payload.text === 'Кнопки управления — под полем ввода.' && Boolean(hintCall.payload.reply_markup?.keyboard),
    `${hintCall.payload.text} | ${JSON.stringify(hintCall.payload.reply_markup)}`,
  );
  check(
    'A: в ряду есть «Старт» и «Как это работает?»',
    hintCall.payload.reply_markup?.keyboard?.[0]?.[0]?.text === '🚀 Старт' && hintCall.payload.reply_markup?.keyboard?.[0]?.[1]?.text === '❓ Как это работает?',
    JSON.stringify(hintCall.payload.reply_markup),
  );
  check('A: текст сохранён как есть', lastPostOf(USER.id)?.text === 'Обычный пост про 2026 год.');
  check('A: синтез запущен', generated.length === 1);

  // B: фото + подпись.
  const beforeB = countPosts();
  await bot.handleUpdate(update({ photo, caption: CAPTION }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const photoCall = statusSend(log);
  check('B: фото + подпись → пост создан', countPosts() === beforeB + 1, `постов: ${countPosts()}`);
  check('B: короткий статус', /Готовим озвучку/.test(photoCall.payload.text), photoCall.payload.text);
  check('B: в пост попала подпись, а не что-то другое', lastPostOf(USER.id)?.text === CAPTION, JSON.stringify(lastPostOf(USER.id)?.text));
  check('B: синтез запущен', generated.length === 2 && generated[1].postId === lastPostOf(USER.id)?.id);

  // C: видео + подпись.
  const beforeC = countPosts();
  await bot.handleUpdate(update({ video, caption: 'Подпись к видео с AI.' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('C: видео + подпись → пост создан', countPosts() === beforeC + 1, `постов: ${countPosts()}`);
  check('C: в пост попала подпись', lastPostOf(USER.id)?.text === 'Подпись к видео с AI.');
  check('C: синтез запущен', generated.length === 3);

  // D: только фото — ни поста, ни ответа.
  const beforeD = countPosts();
  const sendsBeforeD = log.filter((item) => item.method === 'sendMessage').length;
  await bot.handleUpdate(update({ photo }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('D: только фото → пост не создан', countPosts() === beforeD, `постов: ${countPosts()}`);
  check('D: только фото → бот объясняет, что нужен текст', /нужен текст или подпись/.test(lastSend(log).payload.text), lastSend(log).payload.text);
  check('D: синтез не запускался', generated.length === 3);

  // E: только видео — то же самое.
  const beforeE = countPosts();
  const sendsBeforeE = log.filter((item) => item.method === 'sendMessage').length;
  await bot.handleUpdate(update({ video }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('E: только видео → пост не создан', countPosts() === beforeE, `постов: ${countPosts()}`);
  check('E: только видео → бот объясняет, что нужен текст', /нужен текст или подпись/.test(lastSend(log).payload.text), lastSend(log).payload.text);
  void sendsBeforeE;

  // Медиа без подписи в группе: бот не отвечает, чтобы не шуметь в чате.
  const sendsBeforeGroup = log.filter((item) => item.method === 'sendMessage').length;
  await bot.handleUpdate(update({ photo }, { chat: { id: -100, type: 'group', title: 'Группа' } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('медиа без подписи в группе → бот молчит', log.filter((item) => item.method === 'sendMessage').length === sendsBeforeGroup);

  // Логи: у каждого случая своя строка.
  check('лог для текста', logs.some((line) => /^\[post\] type=text textSource=text textLength=\d+$/.test(line)), logs.join(' | '));
  check('лог для фото с подписью', logs.some((line) => /^\[post\] type=photo textSource=caption textLength=\d+$/.test(line)), logs.join(' | '));
  check('лог для видео с подписью', logs.some((line) => line === '[post] type=video textSource=caption textLength=21'), logs.join(' | '));
  check('лог для фото без подписи', logs.some((line) => line === '[post] type=photo textSource=none → skipped'), logs.join(' | '));
  check('лог для видео без подписи', logs.some((line) => line === '[post] type=video textSource=none → skipped'), logs.join(' | '));
  check('ошибок обработки не было', errors.length === 0, errors.join('; '));
}

// --- часть 3: случай F целиком, с настоящим Silero ---------------------------------------

function tempSileroDirs() {
  return readdirSync(require('node:os').tmpdir()).filter((name) => name.startsWith('tg-reader-silero-'));
}

async function testCaptionThroughPipeline() {
  console.log('\n— F: подпись с числами, латиницей, URL и эмодзи —');

  const config = readTtsConfig();

  // Стадии подготовки: видно, что подпись проходит каждый слой.
  const prepared = describePreparation(config, CAPTION, 'silero');
  check('F: числа развёрнуты в слова', /две тысячи двадцать шестом году/.test(prepared.normalized), prepared.normalized);
  check('F: латиница стала русской', /опен эй ай/.test(prepared.latinNormalized) && !/[A-Za-z]/.test(prepared.latinNormalized), prepared.latinNormalized);
  check('F: URL заменён на слово', /Ссылка|ссылка/.test(prepared.latinNormalized), prepared.latinNormalized);
  check('F: просодия размечена SSML', /<speak>/.test(prepared.prosody), prepared.prosody);

  // Эмодзи, хэштег и упоминание — обычное содержимое подписей Telegram.
  const emojiCaption = 'Мы выросли на 15% 🚀 #новости @durov';
  const emojiPrepared = describePreparation(config, emojiCaption, 'silero');
  check('F2: эмодзи остаются в тексте для синтеза', emojiPrepared.latinNormalized.includes('🚀'), emojiPrepared.latinNormalized);
  check('F2: кириллический хэштег остаётся', /#новости/.test(emojiPrepared.latinNormalized), emojiPrepared.latinNormalized);
  check('F2: латинское упоминание стало словом', /упоминание/.test(emojiPrepared.latinNormalized), emojiPrepared.latinNormalized);

  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск синтеза: Silero не настроен в этом окружении');
    return;
  }

  // Настоящий путь: фото с подписью → бот → очередь → Silero → кэш.
  const log = [];
  const errors = [];
  const logs = [];
  const cacheBefore = readdirSync(cacheDir());

  const { bot } = createBot({
    token: TOKEN,
    miniAppUrl: MINI_APP,
    config,
    onError: (message) => errors.push(String(message)),
    onLog: (message) => logs.push(String(message)),
    client: { fetch: createFakeApi(log) },
  });

  await bot.init();
  const voice = await resolveVoiceForProvider(config, 'silero', undefined);

  const cases = [
    { name: 'F', caption: CAPTION, note: 'числа, латиница, URL' },
    { name: 'F2', caption: emojiCaption, note: 'проценты, эмодзи, хэштег, упоминание' },
  ];

  const created = [];

  for (const item of cases) {
    await bot.handleUpdate(update({ photo, caption: item.caption }));
    const postId = lastPostOf(USER.id)?.id;
    created.push(postId);

    let manifest = null;
    for (let i = 0; i < 900 && !manifest; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      manifest = await readManifest(postId, 'silero', voice);
    }

    check(`${item.name}: подпись к фото дошла до Silero и попала в кэш (${item.note})`, Boolean(manifest?.chunks?.length), `postId=${postId}`);
    check(`${item.name}: пост в хранилище содержит подпись целиком`, getPost(postId)?.text === item.caption, JSON.stringify(getPost(postId)?.text));
  }

  check('F: ошибок синтеза нет', errors.length === 0, errors.join('; '));

  // Кэш — рабочий каталог проекта: убираем только то, что создал тест.
  const added = readdirSync(cacheDir()).filter((name) => !cacheBefore.includes(name));
  check('F: лишних каталогов в кэше не появилось', added.every((name) => created.includes(name)), added.join(', '));
  for (const name of added) rmSync(path.join(cacheDir(), name), { recursive: true, force: true });
}

async function main() {
  loadEnv();
  testExtractor();
  await testHandler();
  await testCaptionThroughPipeline();

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
