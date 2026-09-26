// Telegram-бот на grammY.
//
// Интерфейс бота — меню рядом с полем ввода и команды, без клавиатур в сообщениях.
// Кнопка меню ведёт в Post Reader (Mini App), команды /open, /reset и /help живут
// в списке команд. Под постом бот показывает только короткий статус: пост добавлен
// в очередь, готовим озвучку, озвучка готова.
//
// Повторная пересылка того же поста не создаёт новую запись и не запускает синтез:
// дубликаты ловятся по стабильному ключу Telegram (см. telegramPostKey в post-text.js),
// а не по тексту — два разных поста могут иметь одинаковый текст.
import { Bot, Keyboard } from 'grammy';
import { deletePostsOf, findPostByTelegramKey, getPost, postsOfUser, savePost } from './store.js';
import { getSession, postRecord, rememberMessage, sessionStatus } from './session.js';
import { describePost, extractPostText, telegramPostKey } from './post-text.js';
import { createUserQueue } from './user-queue.js';
import { generateAudioForPost } from './generate.js';
import { PUBLIC_PROVIDERS, TtsError, isTtsConfigured, resolveVoiceForProvider } from './tts.js';

// Токен BotFather имеет вид 123456789:AA... — проверяем формат до создания бота,
// чтобы не падать с невнятной ошибкой при незаполненном .env.
const TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

// Токен попадает в URL запросов к api.telegram.org, поэтому его нельзя логировать,
// в том числе внутри текста ошибок. Всё, что уходит в консоль, проходит через scrub().
export function makeScrubber(token) {
  return (value) => String(value).split(token).join('<BOT_TOKEN>');
}

// Никаких клавиатур в сообщениях: ни inline-кнопок, ни reply-клавиатуры.
// Открыть плеер можно кнопкой меню рядом с полем ввода (её задаёт setChatMenuButton),
// а команды /open, /reset, /help живут в списке команд бота.
// Причина, по которой бот не прикладывает клавиатуры: Telegram запрещает редактировать
// сообщение с reply-клавиатурой, а статус поста бот обновляет по ходу синтеза.
const STOP_CALLBACK = 'stop';
const RESET_CALLBACK = 'reset';

// Ряд кнопок под полем ввода (reply-клавиатура). Telegram присылает нажатие обычным
// текстом, поэтому по этим же подписям бот понимает, что нажали.
export const BUTTONS = {
  start: '🚀 Старт',
  clear: '🧹 Очистить плейлист',
  help: '❓ Как это работает?',
  contact: '📮 Связаться',
};

// Меню команд Telegram (Bot API setMyCommands). Язык не указываем: такой список
// Telegram показывает всем, у кого нет своего списка, — то есть русский по умолчанию.
export const COMMANDS = [
  { command: 'start', description: '🚀 Запустить' },
  { command: 'reset', description: '🧹 Сбросить всё' },
  { command: 'help', description: '❓ Как это работает?' },
];

const HOW_IT_WORKS = [
  'Как это работает',
  '',
  '1. Перешли мне пост из Telegram — я добавлю его в очередь и подготовлю озвучку.',
  '2. Нажми кнопку «Post Reader» у поля ввода — откроется плеер с очередью. Mini App можно свернуть: аудио продолжит играть.',
  '3. Кнопки под полем ввода: запустить заново, очистить плейлист, узнать как всё работает, связаться со мной.',
].join('\n');

const PRIVATE_ONLY = 'Открой личный чат с ботом: плеер и команды работают только там.';
const RESET_REPLY = '🧹 Всё сброшено. Можешь прислать новые посты.';
const DUPLICATE_REPLY = 'Этот пост уже в очереди';
const NO_TEXT_REPLY = 'Для озвучки нужен текст или подпись к фото/видео.';
const UNKNOWN_REPLY = 'Пришли пост из Telegram — я добавлю его в очередь. Команды: /open, /reset, /help.';
const LISTEN_FAILED = 'Адрес плеера не настроен на сервере: MINI_APP_URL должен быть HTTPS.';

function isHttps(url) {
  return String(url).startsWith('https://');
}

// Ссылка на разработчика из .env: принимаем и «@ник», и готовый адрес.
function contactUrl(contact) {
  const value = String(contact ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://t.me/${value.replace(/^@/, '')}`;
}

// Ряд кнопок под полем ввода. «Очистить плейлист» показываем только когда есть что
// очищать, «Связаться» — только когда задан адрес разработчика.
function replyKeyboard({ hasPosts = false, supportContact = null } = {}) {
  const keyboard = new Keyboard().text(BUTTONS.start).text(BUTTONS.help).row();
  if (hasPosts) keyboard.text(BUTTONS.clear);
  if (supportContact) keyboard.text(BUTTONS.contact);
  return keyboard.resized();
}

// Короткий статус без служебных подробностей: id поста, число символов и части
// синтеза пользователю не нужны.
function statusText(status) {
  switch (status.kind) {
    case 'queued':
      return '✓ Пост добавлен в очередь';
    case 'running':
      // На длинном посте видно, что работа идёт, а не встала: «часть 2 из 6».
      return status.chunks > 1
        ? `⏳ Готовим озвучку… часть ${status.chunk || 1} из ${status.chunks}`
        : '⏳ Готовим озвучку…';
    case 'ready':
      return '✓ Озвучка готова';
    case 'cancelled':
    case 'dropped':
      return '⏹ Остановлено';
    case 'failed':
      return '⚠️ Не удалось озвучить: похоже, текст слишком плотный для модели. Пришли пост ещё раз — разобью его иначе.';
    case 'unavailable':
      return 'Аудио недоступно: озвучка на сервере не настроена.';
    default:
      return '✓ Пост добавлен в очередь';
  }
}

function startMessage(status) {
  const lines = [
    'Привет! Это Post Reader — плеер для постов Telegram.',
    '',
    HOW_IT_WORKS,
  ];
  const current = statusText(status);
  if (status.kind && status.kind !== 'idle') lines.push('', current);
  return lines.join('\n');
}

export function createBot({
  token,
  miniAppUrl,
  config,
  supportContact = null,
  onError = () => {},
  onLog = () => {},
  generate,
  client,
}) {
  const bot = new Bot(token, { client });
  const scrub = makeScrubber(token);
  const provider = PUBLIC_PROVIDERS[0];
  const canSynthesize = isTtsConfigured(config, provider);
  const contact = contactUrl(supportContact);

  // Клавиатура зависит от состояния: «Очистить плейлист» появляется, когда есть посты.
  const keyboardFor = (userId) => replyKeyboard({ hasPosts: postsOfUser(userId).length > 0, supportContact: contact });

  // Отправляем сообщение и запоминаем его id: полный сброс удалит эти сообщения из чата.
  // Клавиатуру прикладываем только к сообщениям, которые бот потом не редактирует.
  async function send(ctx, text, { withKeyboard = true, userId } = {}) {
    const id = userId ?? ctx.from?.id;
    const message = await ctx.reply(text, withKeyboard ? { reply_markup: keyboardFor(id) } : {});
    rememberMessage(getSession(id), message.message_id);
    return message;
  }

  const report = (error) => {
    if (!error) return;
    const description = error?.error?.description ?? error?.description ?? error?.message ?? error;
    onError(scrub(description));
  };

  bot.catch((err) => report(err));

  // Правки сообщений: Telegram отвечает ошибкой, если текст не изменился, поэтому
  // сравниваем с последним отправленным состоянием и пропускаем такую правку.
  async function editRecord(record, text) {
    if (!record.messageId) return;
    if (record.text === text) return;

    try {
      await bot.api.editMessageText(record.chatId, record.messageId, text);
      record.text = text;
    } catch (error) {
      // Сообщение могли удалить в чате: это не повод считать операцию сломанной.
      const description = String(error?.description ?? error?.message ?? '');
      if (!/message is not modified|message to edit not found|chat not found/i.test(description)) report(error);
    }
  }

  async function finalizeOnReset(record) {
    await editRecord(record, `${record.text ?? ''}\n\n🗑 Плейлист очищен (/reset).`);
  }

  async function resetUser(userId, chatId) {
    const session = getSession(userId);
    session.chatId = chatId;

    // Записи о сообщениях забираем до сброса: после него состояние пустое,
    // а сообщения в чате остались и не должны выглядеть как «Готовим озвучку…».
    const records = [...session.posts.values()].filter((record) => record.messageId);
    const { cancelled, dropped } = queue.clear(userId);
    const removed = deletePostsOf(userId);

    // Сначала помечаем незавершённые статусы (сообщения, которые Telegram не даст удалить,
    // останутся честными), затем удаляем всё, что бот успел отправить.
    for (const record of records) await finalizeOnReset(record);

    let deleted = 0;
    let kept = 0;
    for (const messageId of [...session.sent]) {
      try {
        await bot.api.deleteMessage(chatId, messageId);
        deleted += 1;
      } catch {
        // Telegram удаляет только сообщения младше 48 часов — старые остаются в чате.
        kept += 1;
      }
    }
    session.sent = [];

    return { cancelled, dropped, removed, deleted, kept };
  }

  // Синтез поста в общий кэш. Голос выбирается так же, как его выбирает Mini App
  // по умолчанию: иначе бот и плеер писали бы аудио под разными ключами.
  const run =
    generate ??
    (async (userId, postId, { signal, onProgress }) => {
      const post = getPost(postId);
      if (!post) throw new TtsError('post_missing', 'Пост не найден: состояние могли сбросить (/reset).');

      const voice = await resolveVoiceForProvider(config, provider, undefined);
      const { manifest, cached } = await generateAudioForPost(config, post, { provider, voice, signal, onProgress });
      return { chunks: manifest.chunks.length, cached };
    });

  // Состояние поста для сообщения: живые события очереди и итог операции.
  function statusFromEvent(event) {
    switch (event.type) {
      case 'start':
        return { kind: 'running' };
      case 'progress':
        return { kind: 'running', chunk: event.chunk, chunks: event.chunks };
      case 'queued':
        return { kind: 'queued' };
      case 'ready':
        return { kind: 'ready' };
      case 'failed':
        return { kind: 'failed' };
      case 'cancelled':
      case 'dropped':
        return { kind: 'cancelled' };
      default:
        return null;
    }
  }

  async function handleEvent(event) {
    const session = getSession(event.userId);
    const record = session.posts.get(String(event.postId));
    if (!record?.messageId) return;

    const status = statusFromEvent(event);
    if (status) record.status = status;
    await editRecord(record, statusText(record.status));
  }

  // Операции пользователя идут по очереди; отмена прерывает синтез через AbortSignal.
  const queue = createUserQueue({
    run,
    // handleEvent асинхронный: его отказ нельзя оставлять необработанным, иначе
    // Node уронит процесс целиком.
    onEvent: (event) => {
      handleEvent(event).catch(report);
    },
    onError: report,
  });

  // Меню команд и кнопка меню чата: ошибка сети не должна мешать боту принимать посты.
  const commandsReady = Promise.all([
    bot.api
      .setMyCommands(COMMANDS, { scope: { type: 'all_private_chats' } })
      .then(() => onLog(`[bot] меню команд обновлено: ${COMMANDS.map((item) => `/${item.command}`).join(', ')}`)),
    isHttps(miniAppUrl)
      ? bot.api
          .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Post Reader', web_app: { url: miniAppUrl } } })
          .then(() => onLog('[bot] кнопка меню чата ведёт в Post Reader'))
      : Promise.resolve(),
  ]).catch((error) => {
    report(error);
    return null;
  });

  async function openPlayer(ctx) {
    if (!isHttps(miniAppUrl)) {
      await ctx.reply(LISTEN_FAILED);
      return;
    }
    await send(ctx, 'Плеер открывается кнопкой «Post Reader» у поля ввода. Очередь и озвучка — уже внутри.');
  }

  // Ответы на /start и на кнопку «🚀 Старт» одинаковые: ряд кнопок появляется здесь.
  async function sendStart(ctx) {
    const session = getSession(ctx.from.id);
    session.chatId = ctx.chat.id;
    session.keyboardShown = true;
    await send(ctx, startMessage(sessionStatus(session)));
  }

  async function sendHelp(ctx) {
    getSession(ctx.from.id).keyboardShown = true;
    await send(ctx, HOW_IT_WORKS);
  }

  async function sendReset(ctx) {
    const { cancelled, dropped, removed, deleted, kept } = await resetUser(ctx.from.id, ctx.chat.id);

    const details = [
      `постов убрано: ${removed}`,
      dropped > 0 ? `снято с очереди: ${dropped}` : null,
      cancelled ? 'текущая озвучка остановлена' : null,
      deleted > 0 ? `сообщений удалено: ${deleted}` : null,
      kept > 0 ? `Telegram не дал удалить ${kept} — они старше 48 часов` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    await send(ctx, `${RESET_REPLY}\n\n${details}\nМодели Silero и кэш аудио не тронуты.`);
  }

  async function sendContact(ctx) {
    if (!contact) {
      await send(ctx, 'Адрес для связи пока не задан.');
      return;
    }
    await send(ctx, `Написать разработчику: ${contact}`);
  }

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(PRIVATE_ONLY);
      return;
    }
    await sendStart(ctx);
  });

  bot.command('open', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(PRIVATE_ONLY);
      return;
    }
    await openPlayer(ctx);
  });

  bot.command('help', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(PRIVATE_ONLY);
      return;
    }
    await sendHelp(ctx);
  });

  bot.command('reset', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(PRIVATE_ONLY);
      return;
    }
    await sendReset(ctx);
  });

  // Один обработчик на все сообщения: текст поста берёт extractPostText, поэтому
  // пост с фото/видео и подписью обрабатывается так же, как обычный текст.
  bot.on('message', async (ctx) => {
    const incoming = extractPostText(ctx.message);
    const logLine = describePost(ctx.message);
    if (logLine) onLog(logLine);

    // Медиа без подписи: текста нет, распознавать картинку мы не будем — говорим об этом.
    if (incoming.source === 'none') {
      if (['photo', 'video', 'animation', 'document'].includes(incoming.type) && ctx.chat.type === 'private') {
        await send(ctx, NO_TEXT_REPLY);
      }
      return;
    }

    if (ctx.chat.type !== 'private') {
      await ctx.reply(PRIVATE_ONLY);
      return;
    }

    // Кнопки ряда под полем ввода приходят обычным текстом — обрабатываем их до постов.
    if (incoming.source === 'text' && !ctx.message.forward_origin) {
      if (incoming.text === BUTTONS.start) {
        await sendStart(ctx);
        return;
      }
      if (incoming.text === BUTTONS.help) {
        await sendHelp(ctx);
        return;
      }
      if (incoming.text === BUTTONS.clear) {
        await sendReset(ctx);
        return;
      }
      if (incoming.text === BUTTONS.contact) {
        await sendContact(ctx);
        return;
      }
      // Команда, которую бот не знает, не должна превращаться в пост.
      if (/^\/[A-Za-z0-9_]+/.test(incoming.text)) {
        await send(ctx, UNKNOWN_REPLY);
        return;
      }
    }

    const userId = ctx.from.id;
    const session = getSession(userId);
    session.chatId = ctx.chat.id;

    // Повторная пересылка того же поста: ни новой записи, ни нового синтеза.
    const telegramKey = telegramPostKey(ctx.message);
    const existing = findPostByTelegramKey(userId, telegramKey);
    if (existing) {
      await send(ctx, DUPLICATE_REPLY);
      return;
    }

    const post = savePost(incoming.text, undefined, userId, telegramKey);
    const record = postRecord(session, post.id);
    record.chatId = ctx.chat.id;
    record.status = canSynthesize ? { kind: 'running' } : { kind: 'unavailable' };

    try {
      // Статус бот будет редактировать, поэтому клавиатуру к нему не прикладываем:
      // Telegram запрещает править сообщения с reply-клавиатурой.
      const sent = await ctx.reply(statusText(record.status));
      record.messageId = sent.message_id;
      record.text = sent.text;
      rememberMessage(session, sent.message_id);

      // Первый пост: показываем ряд кнопок отдельным сообщением, чтобы он появился
      // и у тех, кто начал не с /start, а сразу с пересланного поста.
      if (!session.keyboardShown) {
        session.keyboardShown = true;
        const hint = await ctx.reply('Кнопки управления — под полем ввода.', { reply_markup: keyboardFor(userId) });
        rememberMessage(session, hint.message_id);
      }
    } catch (error) {
      // Ответ не отправился, но пост сохранён и синтез всё равно имеет смысл:
      // аудио попадёт в кэш, а плеер его подхватит.
      report(error);
    }

    if (canSynthesize) queue.enqueue(userId, ctx.chat.id, post.id);
  });

  // Кнопки из старых сообщений: отвечаем, чтобы в клиенте не крутился индикатор.
  bot.callbackQuery(/^stop(?::(.+))?$/, async (ctx) => {
    const result = queue.cancel(ctx.from.id, ctx.match?.[1] ?? null);
    const answer = result.ok ? 'Остановлено' : result.reason === 'stale' ? 'Эта операция уже завершена' : 'Сейчас нечего останавливать';
    await ctx.answerCallbackQuery(answer);
  });

  bot.callbackQuery('reset', async (ctx) => {
    await ctx.answerCallbackQuery('Плейлист очищен');
    if (ctx.chat?.type && ctx.chat.type !== 'private') return;
    const { dropped, removed } = await resetUser(ctx.from.id, ctx.chat?.id ?? null);
    await send(ctx, `${RESET_REPLY}\n\nубрано постов: ${removed}${dropped > 0 ? ` · снято с очереди: ${dropped}` : ''}`);
  });

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery('Кнопка устарела. Отправь /open.');
  });

  return { bot, scrub, queue, commandsReady, canSynthesize, provider };
}
