// Минимальный HTTP API для Mini App: текст поста и аудио, сгенерированное TTS.
// Свой сервер на node:http, без express, чтобы не тянуть лишние зависимости.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { readManifest, resolveChunk } from './audio-store.js';
import { generateAudioForPost } from './generate.js';
import { countPosts, getPost, postsOfUser } from './store.js';
import {
  PUBLIC_PROVIDERS,
  TtsError,
  describePreparation,
  describeTts,
  isTtsConfigured,
  isTtsEnabled,
  listSileroVoices,
  makeKeyScrubber,
  readTtsConfig,
  resolveVoiceForProvider,
  voiceLabel,
} from './tts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PoC: Mini App живёт на другом origin (Vite dev server или HTTPS-хостинг).
// Для продакшена нужно ограничить список разрешённых origin.
// ngrok-skip-browser-warning разрешён потому, что Mini App шлёт его через туннель ngrok:
// без него preflight отклоняет запросы с этим заголовком. Другие клиенты его не используют.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS,
  });
  res.end(payload);
}

// Абсолютный адрес API нужен, потому что Mini App живёт на другом домене.
// За обратным прокси (туннелем) схему и хост сообщают заголовки x-forwarded-*.
function publicBase(req) {
  const explicit = (process.env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

function postPayload(post) {
  return {
    id: post.id,
    text: post.text,
    createdAt: new Date(post.createdAt).toISOString(),
    userId: post.userId,
  };
}

function audioPayload(post, manifest, base, cached, provider, voice) {
  const urls = manifest.chunks.map((_, index) => {
    const suffix = index === 0 ? '' : `&i=${index}`;
    return `${base}/api/posts/${post.id}/audio?provider=${encodeURIComponent(provider)}&voice=${encodeURIComponent(voice)}${suffix}`;
  });
  return {
    id: post.id,
    status: 'ready',
    provider,
    voice,
    chunks: manifest.chunks.length,
    chars: post.text.length,
    cached,
    audioUrl: urls[0],
    audioUrls: urls,
  };
}

// Провайдер и голос для синтеза и для ключа кэша.
// Через API доступен только Silero: Piper, macos-say и openai остались в коде как резерв,
// но запросом снаружи больше не выбираются.
async function resolveSelection(config, { provider, voice }) {
  const requestedProvider = String(provider ?? '').trim().toLowerCase();
  const selectedProvider = requestedProvider || 'silero';

  if (!PUBLIC_PROVIDERS.includes(selectedProvider)) {
    throw new TtsError(
      'unknown_provider',
      `Провайдер ${selectedProvider} не доступен. В продукте используется: ${PUBLIC_PROVIDERS.join(', ')}.`,
    );
  }

  return {
    provider: selectedProvider,
    voice: await resolveVoiceForProvider(config, selectedProvider, voice),
  };
}

// Отладочная печать подготовки:
// ORIGINAL → NORMALIZED → LATIN NORMALIZED → PROSODY → PRONUNCIATION → TTS.
// Так видно, на каком слое текст изменился, и какой провайдер получит результат.
// Ударения печатаются только для слов, которые словарь действительно поправил.
function logPreparation(prepared) {
  console.log(`[prepare] ORIGINAL:        ${prepared.original}`);
  console.log(`[prepare] NORMALIZED:      ${prepared.normalized}`);
  console.log(`[prepare] LATIN NORMALIZED: ${prepared.latinNormalized}`);
  console.log(`[prepare] PROSODY:         ${prepared.prosody}`);
  for (const change of prepared.pronunciation ?? []) {
    console.log(`[pronunciation] original="${change.word}" normalized="${change.marked}"`);
  }
  console.log(`[prepare] TTS:             ${prepared.provider}`);
}

// Провайдер TTS ещё не подключён. Отвечаем 200 и понятным статусом: для Mini App это
// не сбой, а ожидаемое состояние — плеер остаётся недоступным, текст поста виден.
function notImplementedPayload(post, provider = null) {
  return {
    id: post.id,
    status: 'not_implemented',
    provider: provider ?? null,
    chunks: 0,
    chars: post.text.length,
    audioUrl: null,
    audioUrls: [],
    message:
      provider && provider !== 'none'
        ? `Провайдер ${provider} не настроен на сервере: проверьте его окружение и переменные TTS_* (см. docs/tts.md).`
        : 'Провайдер TTS не подключён (TTS_PROVIDER=none). Подключение провайдера — отдельный шаг, см. docs/tts.md.',
  };
}

// Разбор заголовка Range: нужен, чтобы iOS/webview могли перематывать аудио.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
  let end = rawEnd === '' || rawStart === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  return start > end ? 'invalid' : { start, end };
}

async function sendAudio(res, postId, provider, voice, index, req) {
  const chunk = await resolveChunk(postId, provider, voice, index);
  if (!chunk) return sendJson(res, 404, { error: 'audio_not_found', message: 'Аудио для этого поста ещё не сгенерировано.' });

  const info = await stat(chunk.path);
  const range = parseRange(req.headers.range, info.size);

  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, ...CORS });
    return res.end();
  }

  const headers = {
    'Content-Type': chunk.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ...CORS,
  };

  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
    });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
  }

  const stream = range
    ? createReadStream(chunk.path, { start: range.start, end: range.end })
    : createReadStream(chunk.path);
  // Файл мог исчезнуть между stat и чтением: обрываем один запрос, а не весь процесс.
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

function createHandler({ webhook = null } = {}) {
  const ttsConfig = readTtsConfig();
  const scrub = makeKeyScrubber(ttsConfig);

  const route = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Апдейты Telegram приходят сюда. Ответ и разбор тела — на стороне grammY:
    // он же сверяет заголовок X-Telegram-Bot-Api-Secret-Token и отвечает 401 на чужой запрос.
    if (webhook && url.pathname === webhook.path) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешён только POST.' });
      return webhook.handler(req, res);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        posts: countPosts(),
        tts: {
          provider: ttsConfig.provider,
          enabled: isTtsEnabled(ttsConfig),
          configured: isTtsConfigured(ttsConfig),
          // Показываем только провайдеров, доступных в продукте (сейчас это Silero).
          providers: Object.fromEntries(PUBLIC_PROVIDERS.map((name) => [name, isTtsConfigured(ttsConfig, name)])),
        },
      });
    }

    // Очередь пользователя: Mini App открывается одной кнопкой, без ссылки на конкретный
    // пост, поэтому список постов она забирает отсюда — в порядке поступления.
    if (url.pathname === '/api/queue') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешён только GET.' });
      const userId = String(url.searchParams.get('userId') ?? '').trim();
      if (!userId) return sendJson(res, 400, { error: 'no_user', message: 'Передайте ?userId=<id пользователя Telegram>.' });

      return sendJson(res, 200, {
        userId,
        posts: postsOfUser(userId).map((post) => ({
          id: post.id,
          text: post.text,
          createdAt: new Date(post.createdAt).toISOString(),
        })),
      });
    }

    // Отладка подготовки текста: что было в посте и что пройдёт каждый слой по очереди.
    if (url.pathname === '/api/normalize') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешён только GET.' });
      const text = url.searchParams.get('text');
      if (!text) return sendJson(res, 400, { error: 'no_text', message: 'Передайте ?text=<текст поста>.' });

      const prepared = describePreparation(ttsConfig, text, 'silero');
      logPreparation(prepared);

      return sendJson(res, 200, {
        provider: prepared.provider,
        tts: describeTts(ttsConfig),
        maxChars: prepared.maxChars,
        chunks: prepared.chunks.length,
        chunkLengths: prepared.chunks.map((c) => c.length),
        breaks: prepared.breaks,
        original: prepared.original,
        normalized: prepared.normalized,
        latinNormalized: prepared.latinNormalized,
        prosody: prepared.prosody,
        pronunciation: prepared.pronunciation,
      });
    }

    // Голоса для переключателя: в продукте остался один провайдер — Silero.
    // Piper, macos-say и openai убраны из публичного API (код сохранён как резерв).
    if (url.pathname === '/api/voices') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешён только GET.' });

      let sileroVoices = [];
      let sileroError = null;
      try {
        sileroVoices = (await listSileroVoices(ttsConfig)).map((name) => ({ name, label: voiceLabel(name) }));
      } catch (error) {
        sileroError = scrub(error.message);
      }

      return sendJson(res, 200, {
        provider: 'silero',
        providers: { silero: sileroVoices },
        // Поле voices оставлено для уже задеплоенной версии Mini App: она читает плоский список.
        default: sileroVoices[0]?.name ?? null,
        voices: sileroVoices,
        silero: { model: ttsConfig.sileroModel, error: sileroError },
      });
    }

    // Текст поста. /api/post/:id оставлен как синоним: на него уже задеплоена первая версия Mini App.
    const postMatch = url.pathname.match(/^\/api\/posts?\/([^/]+)$/);
    if (postMatch && req.method === 'GET') {
      const post = UUID_PATTERN.test(postMatch[1]) ? getPost(postMatch[1]) : null;
      if (!post) return sendJson(res, 404, { error: 'post_not_found', message: 'Пост с таким id не найден.' });
      return sendJson(res, 200, postPayload(post));
    }

    const audioMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/audio$/);
    if (audioMatch) {
      const postId = UUID_PATTERN.test(audioMatch[1]) ? audioMatch[1] : null;
      const post = postId ? getPost(postId) : null;
      if (!post) return sendJson(res, 404, { error: 'post_not_found', message: 'Пост с таким id не найден.' });

      // Без ?provider= берётся провайдер из конфига, без ?voice= — голос по умолчанию:
      // поведение основного сценария не меняется.
      let selection;
      try {
        selection = await resolveSelection(ttsConfig, {
          provider: url.searchParams.get('provider'),
          voice: url.searchParams.get('voice'),
        });
      } catch (error) {
        if (error instanceof TtsError) return sendJson(res, 400, { error: error.code, message: scrub(error.message) });
        throw error;
      }
      const { provider, voice } = selection;

      if (req.method === 'GET') {
        const index = Number(url.searchParams.get('i') || 0);
        if (!Number.isInteger(index) || index < 0) {
          return sendJson(res, 400, { error: 'bad_chunk', message: 'Номер части должен быть целым неотрицательным числом.' });
        }
        return sendAudio(res, post.id, provider, voice, index, req);
      }

      if (req.method === 'POST') {
        const base = publicBase(req);
        // Кэш и защиту от дублей держит общий с ботом слой generate.js: если бот уже
        // подготовил аудио для этого поста, ответ придёт из кэша без повторного синтеза.
        const existing = await readManifest(post.id, provider, voice);
        if (existing) return sendJson(res, 200, audioPayload(post, existing, base, true, provider, voice));

        // Провайдер не подключён: отдаём заглушку и не обращаемся ни к каким сетям.
        if (provider === 'none' || !isTtsConfigured(ttsConfig, provider)) {
          const note = provider === 'none' ? 'провайдер не подключён' : `провайдер ${provider} не настроен`;
          console.log(`[tts] пост ${post.id}: ${note}, отдаю not_implemented`);
          return sendJson(res, 200, notImplementedPayload(post, provider));
        }

        // Слои подготовки перед синтезом: числа → слова, латиница → русская форма,
        // затем паузы и структура.
        const prepared = describePreparation(ttsConfig, post.text, provider);
        logPreparation(prepared);

        try {
          const { manifest, cached } = await generateAudioForPost(ttsConfig, post, { provider, voice });
          console.log(`[tts] пост ${post.id}, ${provider}/${voice}: ${prepared.normalized.length} символов после нормализации → ${manifest.chunks.length} часть(ей)`);
          return sendJson(res, 200, audioPayload(post, manifest, base, cached, provider, voice));
        } catch (error) {
          const isTts = error instanceof TtsError;
          const message = scrub(error.message);
          console.error(`[tts] ошибка: ${isTts ? `${error.code}: ` : ''}${message}`);
          const status = { tts_not_configured: 503, tts_empty_text: 400, unknown_voice: 400, unknown_provider: 400 }[error.code] ?? 502;
          return sendJson(res, status, { error: isTts ? error.code : 'tts_failed', message });
        }
      }

      return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешены GET и POST.' });
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Разрешён только GET.' });

    return sendJson(res, 404, { error: 'not_found', message: 'Такого endpoint нет.' });
  };

  // Обработчик асинхронный: без этого любое исключение внутри стало бы unhandled rejection,
  // а запрос остался бы висеть без ответа.
  return async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error('[api] ошибка обработки запроса:', scrub(error?.message ?? error));
      if (res.headersSent) return res.destroy();
      return sendJson(res, 500, { error: 'internal_error', message: 'Внутренняя ошибка сервера.' });
    }
  };
}

// webhook задаётся только в режиме BOT_MODE=webhook: сервер принимает апдейты Telegram
// на webhook.path и передаёт их боту.
export function startApi({ port, webhook = null }) {
  const server = http.createServer(createHandler({ webhook }));

  server.listen(port, () => {
    console.log(
      `[api] HTTP API слушает http://localhost:${port} (GET /api/posts/:id, POST /api/posts/:id/audio, GET /api/posts/:id/audio)`,
    );
    if (webhook) console.log(`[api] апдейты Telegram принимаются на ${webhook.path}`);
  });

  return server;
}
