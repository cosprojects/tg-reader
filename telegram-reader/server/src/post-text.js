// Извлечение текста поста из Telegram-сообщения.
//
// Telegram передаёт текст по-разному: у обычного сообщения это message.text,
// у медиа — message.caption (photo, video, animation, document, audio).
// Бот слушал только message:text, поэтому пост с фото или видео и подписью
// не обрабатывался вовсе, хотя текст в сообщении был.
//
// OCR здесь нет и не появится: распознавание текста на картинке или в видео —
// отдельная задача. Этот модуль берёт только то, что Telegram уже передал
// в message.text или message.caption, ничего не додумывая.

// Поля, которыми Telegram помечает медиа-сообщения. Список нужен для типа в логе
// и для тестов; на обработку он не влияет — решение принимается по наличию текста.
const MEDIA_FIELDS = ['photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker', 'story'];

// Тип сообщения: text | photo | video | … | other.
// 'other' — служебные сообщения (закрепление, вход в чат и подобное), их не логируем.
export function messageKind(message) {
  if (typeof message?.text === 'string') return 'text';

  for (const field of MEDIA_FIELDS) {
    if (message?.[field] !== undefined) return field;
  }

  if (message?.poll) return 'poll';
  if (message?.location || message?.venue) return 'location';
  if (message?.contact) return 'contact';

  return 'other';
}

// Единая точка входа: текст поста и его источник.
// source = 'text' — обычное сообщение, 'caption' — подпись к медиа,
// 'none' — текста нет, озвучивать нечего.
export function extractPostText(message) {
  const type = messageKind(message);

  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (text) return { type, source: 'text', text };

  const caption = typeof message?.caption === 'string' ? message.caption.trim() : '';
  if (caption) return { type, source: 'caption', text: caption };

  return { type, source: 'none', text: '' };
}

// Стабильный ключ исходного поста в Telegram — по нему ловим повторную пересылку.
//
// У пересланного поста из канала есть канал и номер сообщения: они не меняются,
// сколько бы раз пользователь его ни переслал. У пересылки от человека номера
// исходного сообщения Telegram не отдаёт, поэтому берём автора и исходную дату.
// У обычного (не пересланного) сообщения стабильного id исходного поста нет —
// возвращаем null, и такое сообщение дубликатом не считается: сравнивать по тексту
// нельзя, два разных поста могут иметь одинаковый текст.
export function telegramPostKey(message) {
  const origin = message?.forward_origin;
  if (!origin) return null;

  if (origin.type === 'channel' && origin.chat?.id && origin.message_id) {
    return `channel:${origin.chat.id}:${origin.message_id}`;
  }
  if (origin.type === 'user' && origin.sender_user?.id && origin.date) {
    return `user:${origin.sender_user.id}:${origin.date}`;
  }
  if (origin.type === 'hidden_user' && origin.sender_user_name && origin.date) {
    return `hidden:${origin.sender_user_name}:${origin.date}`;
  }

  return null;
}

// Строка для лога при получении поста:
//   [post] type=photo textSource=caption textLength=123
//   [post] type=text textSource=text textLength=123
//   [post] type=photo textSource=none → skipped
// Для служебных сообщений возвращает null: логировать их нечего.
export function describePost(message) {
  const post = extractPostText(message);
  if (post.type === 'other') return null;
  if (post.source === 'none') return `[post] type=${post.type} textSource=none → skipped`;

  return `[post] type=${post.type} textSource=${post.source} textLength=${post.text.length}`;
}
