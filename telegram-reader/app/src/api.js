// Клиент backend для Mini App.
//
// Публичный адрес API подставляет сборка из PUBLIC_API_BASE (app/vite.config.js):
// localhost здесь намеренно не захардкожен — если переменная не задана, интерфейс
// покажет ошибку настройки, а не пустой экран.
export const API_BASE = __PUBLIC_API_BASE__;

// Бесплатный тариф ngrok отдаёт браузерным запросам страницу-предупреждение (ERR_NGROK_6024)
// вместо ответа backend. Этот заголовок её отключает; другие серверы его игнорируют.
// Медиаэлемент приложить свой заголовок не может, поэтому аудио качается через fetch.
const NGROK_BYPASS_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Ошибка с кодом от backend: по нему интерфейс отличает «пост пропал» от сбоя сети.
export class ApiError extends Error {
  constructor(message, { code = null, status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function readError(response) {
  try {
    const body = await response.json();
    return new ApiError(body?.message || body?.error || `HTTP ${response.status}`, {
      code: body?.error ?? null,
      status: response.status,
    });
  } catch {
    return new ApiError(`HTTP ${response.status}`, { status: response.status });
  }
}

// Сбой сети выглядит как «Failed to fetch» — для пользователя это бессмысленно,
// поэтому объясняем, куда шёл запрос.
export function describeFetchError(error) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError || error?.name === 'TimeoutError') {
    return `Backend не отвечает по адресу ${API_BASE} (${error.message}).`;
  }
  return error?.message ?? 'Неизвестная ошибка';
}

// Проверки окружения до первого запроса: без адреса API и на смешанном содержимом
// браузер всё равно заблокирует запрос, поэтому причину показываем заранее.
export function checkEnvironment() {
  if (!API_BASE) {
    return 'Адрес backend не задан. Mini App собирается с PUBLIC_API_BASE в .env.';
  }
  if (window.location.protocol === 'https:' && API_BASE.startsWith('http://')) {
    return `Mini App открыт по HTTPS, а адрес backend — ${API_BASE}: браузер заблокирует запрос. Нужен HTTPS-адрес.`;
  }
  return null;
}

async function request(path, { method = 'GET', signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, { method, headers: NGROK_BYPASS_HEADERS, signal });
  if (!response.ok) throw await readError(response);
  return response.json();
}

// Текст поста: { id, text, createdAt }.
export function fetchPost(id, { signal } = {}) {
  return request(`/api/posts/${encodeURIComponent(id)}`, { signal });
}

// Аудио поста. Без voice backend берёт голос по умолчанию; повторный запрос
// для того же поста и голоса отдаёт готовый файл из кэша (cached: true).
export function requestAudio(id, { voice, signal } = {}) {
  const query = voice ? `?voice=${encodeURIComponent(voice)}` : '';
  return request(`/api/posts/${encodeURIComponent(id)}/audio${query}`, { method: 'POST', signal });
}

// Очередь пользователя: Mini App открывается кнопкой «🎧 Слушать» без ссылки на пост,
// поэтому список постов берётся здесь — в порядке поступления их в бот.
export function fetchQueue(userId, { signal } = {}) {
  if (!userId) return Promise.resolve({ posts: [] });
  return request(`/api/queue?userId=${encodeURIComponent(userId)}`, { signal });
}

// Список голосов: нужен, чтобы сопоставить понятные пользователю «мужской/женский»
// с реально установленными голосами модели.
export function fetchVoices({ signal } = {}) {
  return request('/api/voices', { signal });
}

// Части аудио скачиваются как Blob: медиаэлемент не может приложить заголовок для ngrok,
// а object URL отдаёт браузеру уже локальные данные — без сети и без Range.
export async function downloadAudio(urls, { signal } = {}) {
  const objectUrls = [];
  try {
    for (const url of urls) {
      const response = await fetch(url, { headers: NGROK_BYPASS_HEADERS, signal });
      if (!response.ok) throw await readError(response);
      objectUrls.push(URL.createObjectURL(await response.blob()));
    }
  } catch (error) {
    releaseAudio(objectUrls);
    throw error;
  }
  return objectUrls;
}

// Blob-адреса нужно освобождать вручную, иначе они живут до перезагрузки страницы.
export function releaseAudio(urls) {
  for (const url of urls ?? []) URL.revokeObjectURL(url);
}
