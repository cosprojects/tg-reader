// In-memory хранилище постов. PoC: данные живут только в процессе сервера,
// при перезапуске бота список пустеет. Базы данных здесь сознательно нет.
import { randomUUID } from 'node:crypto';

const posts = new Map();

// Ключ поста в Telegram → id поста, чтобы один и тот же пересланный пост не попадал
// в очередь дважды. Ключ включает пользователя: один и тот же пост из канала,
// пересланный двумя людьми, — это два разных поста в двух разных очередях.
const telegramIndex = new Map();

function indexKey(userId, telegramKey) {
  return `${userId ?? '-'}:${telegramKey}`;
}

// Второй аргумент нужен только для восстановления известного поста после перезапуска
// (например, при сравнении TTS на одном и том же тексте). Бот его не передаёт.
// Третий — id пользователя Telegram: по нему /reset удаляет посты только этого человека.
// Четвёртый — стабильный ключ поста в Telegram (см. telegramPostKey): по нему ловим дубликаты.
export function savePost(text, id = randomUUID(), userId = null, telegramKey = null) {
  // Эмодзи и разметку не чистим: TTS-провайдеры игнорируют эмодзи сами,
  // а лишние преобразования текста в PoC только мешают сверять пост с озвучкой.
  const post = {
    id,
    text: String(text).trim(),
    createdAt: Date.now(),
    userId: userId === null || userId === undefined ? null : String(userId),
    telegramKey: telegramKey ?? null,
  };
  posts.set(post.id, post);
  if (post.telegramKey) telegramIndex.set(indexKey(post.userId, post.telegramKey), post.id);
  return post;
}

// Пост, который пользователь уже присылал: его повторная пересылка не создаёт новую запись.
export function findPostByTelegramKey(userId, telegramKey) {
  if (!telegramKey) return null;
  const id = telegramIndex.get(indexKey(userId === null || userId === undefined ? null : String(userId), telegramKey));
  return id ? posts.get(id) ?? null : null;
}

// Очередь пользователя в порядке поступления: её показывает Mini App.
export function postsOfUser(userId) {
  const owner = String(userId);
  return [...posts.values()].filter((post) => post.userId === owner);
}

export function getPost(id) {
  return posts.get(id) ?? null;
}

export function countPosts() {
  return posts.size;
}

// /reset: убираем посты одного пользователя. Аудио в кэше остаётся — оно общее,
// и модели Silero стирать тем более нечего.
export function deletePostsOf(userId) {
  const owner = String(userId);
  let removed = 0;

  for (const [id, post] of posts) {
    if (post.userId === owner) {
      posts.delete(id);
      if (post.telegramKey) telegramIndex.delete(indexKey(owner, post.telegramKey));
      removed += 1;
    }
  }

  return removed;
}
