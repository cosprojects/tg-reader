// Очередь операций пользователя: синтез идёт по одному на пользователя, следующий пост ждёт.
//
// «⏹ Остановить» прерывает только текущую операцию этого пользователя: long polling и процесс
// backend продолжают работать, другие пользователи не затронуты. Прерывание настоящее —
// AbortSignal доходит до провайдера и убивает запущенный процесс синтеза, поэтому в кэш
// ничего не попадает и пользователь не получает недосчитанное аудио.
import { getSession } from './session.js';

export function createUserQueue({ run, onEvent = () => {}, onError = () => {} }) {
  const emit = (event) => {
    try {
      onEvent(event);
    } catch (error) {
      onError(error);
    }
  };

  // Снимает очередь пользователя и сообщает о каждом снятом посте: сообщения с этими
  // постами остались в чате и должны перестать выглядеть как «Ждёт очереди».
  function dropQueued(userId) {
    const session = getSession(userId);
    const dropped = session.queue.map((item) => item.postId);
    session.queue = [];

    for (const postId of dropped) emit({ type: 'dropped', userId, postId });
    return dropped;
  }

  async function start(userId, postId) {
    const session = getSession(userId);
    // Поколение фиксируем до запуска: /reset во время синтеза делает события неактуальными.
    const epoch = session.epoch;
    const controller = new AbortController();

    session.active = { postId, controller, chunk: 0, chunks: 0 };
    emit({ type: 'start', userId, postId });

    let outcome;
    try {
      const result = await run(userId, postId, {
        signal: controller.signal,
        onProgress: (progress) => {
          const current = getSession(userId);
          if (current.epoch !== epoch || current.active?.postId !== postId) return;
          current.active.chunk = progress.chunk;
          current.active.chunks = progress.chunks;
          emit({ type: 'progress', userId, postId, chunk: progress.chunk, chunks: progress.chunks });
        },
      });

      outcome = controller.signal.aborted
        ? { type: 'cancelled' }
        : { type: 'ready', chunks: result?.chunks ?? 0, cached: Boolean(result?.cached) };
    } catch (error) {
      outcome =
        controller.signal.aborted || error?.code === 'tts_cancelled'
          ? { type: 'cancelled' }
          : { type: 'failed', message: String(error?.message ?? error) };
    }

    const current = getSession(userId);
    // Состояние сбросили через /reset: операция больше не принадлежит интерфейсу.
    if (current.epoch !== epoch) return;

    if (current.active?.postId === postId) current.active = null;
    emit({ ...outcome, userId, postId });

    const next = current.queue.shift();
    if (next) start(userId, next.postId);
  }

  return {
    // 'started' — синтез начался сразу, 'queued' — пост встал за текущей операцией.
    enqueue(userId, chatId, postId) {
      const session = getSession(userId);
      session.chatId = chatId;
      session.postId = postId;

      if (session.active) {
        session.queue.push({ postId });
        emit({ type: 'queued', userId, postId });
        return 'queued';
      }

      start(userId, postId);
      return 'started';
    },

    // expectedPostId приходит из callback data: кнопка старого сообщения не должна
    // останавливать операцию по новому посту.
    cancel(userId, expectedPostId = null) {
      const session = getSession(userId);
      const active = session.active;

      if (!active) {
        const dropped = dropQueued(userId);
        return dropped.length > 0
          ? { ok: false, reason: 'queue_cleared', dropped }
          : { ok: false, reason: 'idle', dropped };
      }

      if (expectedPostId && String(active.postId) !== String(expectedPostId)) {
        return { ok: false, reason: 'stale', postId: active.postId, dropped: [] };
      }

      const dropped = dropQueued(userId);
      active.controller.abort();
      return { ok: true, postId: active.postId, dropped };
    },

    // /reset: состояние пользователя обнуляется, активная операция прерывается.
    // Модели, кэш аудио и данные других пользователей не затрагиваются.
    clear(userId) {
      const session = getSession(userId);
      const active = session.active;
      const dropped = session.queue.length;

      session.queue = [];
      session.active = null;
      session.postId = null;
      session.epoch += 1;
      session.posts.clear();
      if (active) active.controller.abort();

      return { cancelled: Boolean(active), dropped };
    },

    isRunning(userId) {
      return Boolean(getSession(userId).active);
    },
  };
}
