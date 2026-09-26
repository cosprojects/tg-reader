// Состояние пользователя Telegram Reader: его посты, очередь синтеза, активная операция
// и ссылки на сообщения бота. Живёт в памяти процесса — как и store.js, перезапуск не переживает.
//
// Ключ — id пользователя Telegram: /reset одного человека не должен задевать других.

// Сколько последних постов пользователя помним в интерфейсе. Старые записи нужны только
// для того, чтобы обновить уже отправленное сообщение, поэтому список ограничен.
const MAX_TRACKED_POSTS = 5;
// Сколько id сообщений бота держим для полного сброса: Telegram всё равно позволяет
// удалять только сообщения младше 48 часов.
const MAX_TRACKED_MESSAGES = 100;

function createSession(userId) {
  return {
    userId,
    chatId: null,
    // Последний присланный пост: его показывает /start, к нему ведёт «🎧 Слушать».
    postId: null,
    // Посты, ждущие синтеза: пользователь может прислать несколько подряд.
    queue: [],
    // Активная операция: { postId, controller, chunk, chunks } либо null.
    active: null,
    // Номер поколения состояния: /reset его увеличивает, чтобы события прерванной
    // операции не попали в уже сброшенный интерфейс.
    epoch: 0,
    // Посты в интерфейсе: postId → { postId, chatId, messageId, text, keyboard, status }.
    posts: new Map(),
    // Id отправленных сообщений — их удаляет полный сброс.
    sent: [],
    // Показывали ли этому пользователю ряд кнопок под полем ввода.
    keyboardShown: false,
    updatedAt: Date.now(),
  };
}

const sessions = new Map();

function key(userId) {
  return String(userId);
}

export function getSession(userId) {
  const id = key(userId);
  let session = sessions.get(id);
  if (!session) {
    session = createSession(id);
    sessions.set(id, session);
  }
  session.updatedAt = Date.now();
  return session;
}

export function peekSession(userId) {
  return sessions.get(key(userId)) ?? null;
}

// Запись о сообщении с постом. Хранит последний отрисованный текст и клавиатуру:
// по ним бот понимает, нужно ли вообще править сообщение.
export function postRecord(session, postId) {
  const id = key(postId);
  const existing = session.posts.get(id);
  if (existing) return existing;

  const record = {
    postId: id,
    chatId: session.chatId,
    messageId: null,
    text: null,
    keyboard: null,
    status: { kind: 'idle' },
  };
  session.posts.set(id, record);
  pruneRecords(session);
  return record;
}

// Держим только последние записи и никогда не выбрасываем те, что ещё участвуют в работе.
function pruneRecords(session) {
  const busy = new Set([session.active?.postId, ...session.queue.map((item) => item.postId)].filter(Boolean));

  for (const id of session.posts.keys()) {
    if (session.posts.size <= MAX_TRACKED_POSTS) return;
    if (busy.has(id)) continue;
    session.posts.delete(id);
  }
}

// /reset: в интерфейсе не остаётся ни одной записи о постах пользователя.
export function clearPosts(session) {
  session.posts.clear();
}

// Запоминаем id отправленного сообщения: полный сброс удаляет их из чата.
export function rememberMessage(session, messageId) {
  if (!messageId) return;
  session.sent.push(messageId);
  if (session.sent.length > MAX_TRACKED_MESSAGES) session.sent.splice(0, session.sent.length - MAX_TRACKED_MESSAGES);
}

// Состояние поста для интерфейса: живое (идёт синтез или пост в очереди) берётся
// из очереди, итоговое — из записи сообщения.
export function statusForPost(session, postId) {
  const id = key(postId);

  if (session.active?.postId === id) {
    return { kind: 'running', chunk: session.active.chunk, chunks: session.active.chunks };
  }
  if (session.queue.some((item) => item.postId === id)) return { kind: 'queued' };
  return session.posts.get(id)?.status ?? { kind: 'idle' };
}

// Состояние пользователя целиком: нужно /start, чтобы показать, что происходит сейчас.
export function sessionStatus(session) {
  if (session.active) {
    return {
      kind: 'running',
      postId: session.active.postId,
      chunk: session.active.chunk,
      chunks: session.active.chunks,
    };
  }
  if (session.queue.length > 0) {
    return { kind: 'queued', postId: session.postId, queued: session.queue.length };
  }
  if (session.postId) return statusForPost(session, session.postId);
  return { kind: 'idle' };
}
