// Плейлист Mini App.
//
// Backend не отдаёт список постов: GET /api/posts отвечает 404, потому что бот публикует
// пост ссылкой с одним id. Поэтому очередь собирается на устройстве — каждый открытый
// пост добавляется в конец — и хранится в localStorage. Другого способа показать
// очередь без изменения backend нет.
//
// Что храним: id, первую строку поста (нужна списку до обращения к API), метку источника
// и голос, которым пост уже озвучен. Полный текст и blob-адреса аудио не сохраняем:
// первые приходят из API, вторые живут только внутри сессии.

const STORAGE_KEY = 'post-reader:playlist:v1';

export function firstLine(text) {
  return String(text ?? '').split('\n').find((line) => line.trim())?.trim() ?? '';
}

// Источник поста backend не передаёт (в посте есть только текст и время), поэтому
// в строке источника показываем время — как метку на кассете.
export function sourceLabel(createdAt) {
  if (!createdAt) return 'ПОСТ';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'ПОСТ';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}.${month} ${hours}:${minutes}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function makeEntry({ id, text = '', createdAt = null, appliedVoice = null, played = false }) {
  return { id, firstLine: firstLine(text), source: sourceLabel(createdAt), createdAt, appliedVoice, played };
}

// Пост из ссылки бота или из очереди backend: новый добавляется в конец,
// уже известный обновляет описание, но сохраняет своё состояние (played, голос).
export function upsertEntry(entries, entry) {
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index === -1) return { entries: [...entries, entry], added: true };

  const updated = [...entries];
  updated[index] = {
    ...updated[index],
    ...entry,
    played: updated[index].played ?? entry.played,
    appliedVoice: updated[index].appliedVoice ?? entry.appliedVoice,
  };
  return { entries: updated, added: false };
}

// Слияние с очередью backend: известные посты сохраняют порядок и состояние,
// новые дописываются в конец — как и посты из ссылок.
//
// prune нужен, когда очередь на backend очистили командой /reset: тогда записи,
// которых больше нет на сервере, убираются и из плейлиста приложения — иначе
// пользователь видел бы ссылки на посты, которых уже нет.
export function mergeQueue(entries, posts, { prune = false } = {}) {
  const serverIds = new Set(posts.map((post) => post.id));
  const base = prune ? entries.filter((entry) => serverIds.has(entry.id)) : entries;
  const removed = entries.length - base.length;

  let next = base;
  let added = 0;

  for (const post of posts) {
    const result = upsertEntry(next, makeEntry({ id: post.id, text: post.text, createdAt: post.createdAt }));
    next = result.entries;
    if (result.added) added += 1;
  }

  return { entries: next, added, removed };
}

export function updateEntry(entries, id, patch) {
  return entries.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function removeEntry(entries, id) {
  return entries.filter((item) => item.id !== id);
}

export function moveEntry(entries, from, to) {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return entries;
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function neighbour(entries, currentId, step) {
  const index = entries.findIndex((item) => item.id === currentId);
  if (index === -1) return null;
  const target = index + step;
  return entries[target] ?? null;
}

export function readPlaylist() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];

    // Данные могли остаться от прежней версии интерфейса: оставляем только записи с id.
    return raw
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({
        id: item.id,
        firstLine: typeof item.firstLine === 'string' ? item.firstLine : '',
        source: typeof item.source === 'string' ? item.source : 'ПОСТ',
        createdAt: item.createdAt ?? null,
        appliedVoice: typeof item.appliedVoice === 'string' ? item.appliedVoice : null,
        played: Boolean(item.played),
      }));
  } catch {
    return [];
  }
}

export function savePlaylist(entries) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Приватный режим браузера может запретить запись: плейлист тогда живёт одну сессию.
  }
}
