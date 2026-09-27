// Text-to-Speech. Работает только на сервере: ключ провайдера читается здесь
// и никогда не попадает ни во фронтенд, ни в логи, ни в ответы API.
//
// Провайдер выбирается переменной TTS_PROVIDER:
//   none      — провайдер не подключён (значение по умолчанию): POST /api/posts/:id/audio
//               вернёт заглушку {"status":"not_implemented"}, никакие сети не вызываются.
//   piper     — локальный синтез Piper (Python-пакет piper-tts), ключ и сеть не нужны.
//   silero    — локальный синтез Silero (Python-пакет silero + torch), ключ и сеть не нужны.
//   openai    — POST {TTS_BASE_URL}/audio/speech, ключ в TTS_API_KEY.
//   macos-say — локальный синтез macOS (`say`), ключ не нужен. Только для отладки на macOS.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeText } from './text-normalize.js';
import { normalizeLatin } from './text-latin.js';
import { buildSsml } from './text-prosody.js';
import { applyPronunciation, loadPronunciationRules } from './text-pronounce.js';
import { sanitizeSileroSsml } from './text-sanitize.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));

// Голоса Piper лежат рядом с кодом сервера; каталог в .gitignore (модель весит ~60 МБ).
const DEFAULT_PIPER_DATA_DIR = path.resolve(here, '..', '.piper-voices');
const DEFAULT_PIPER_MODEL = 'ru_RU-ruslan-medium';

// Silero живёт в своём venv внутри server/ — окружение Piper не затрагивается.
const DEFAULT_SILERO_PYTHON = path.resolve(here, '..', '.venv-silero', 'bin', 'python3');
const DEFAULT_SILERO_SCRIPT = path.resolve(here, '..', 'silero_tts_cli.py');
const DEFAULT_SILERO_DATA_DIR = path.resolve(here, '..', '.silero');
const DEFAULT_SILERO_MODEL = 'v5_5_ru';
const DEFAULT_SILERO_SAMPLE_RATE = 48_000;
// У Silero свой предел на длину строки: модель сама предупреждает начиная с 1000 символов,
// а примерно с 1200 падает с «Model couldn't generate your text, probably it's too long».
// 800 оставляет запас на случай, когда числа и сокращения разворачиваются в слова.
const DEFAULT_SILERO_MAX_CHARS = 800;

// В продукте работает только Silero. Это провайдеры, доступные через публичный API:
// вызвать Piper, macos-say или openai запросом снаружи больше нельзя.
export const PUBLIC_PROVIDERS = ['silero'];

// Провайдеры, реализованные в коде. Piper, macos-say и openai остаются работоспособными,
// но выключены из продукта: их можно включить только правкой TTS_PROVIDER в .env.
export const KNOWN_PROVIDERS = ['piper', 'silero', 'macos-say', 'openai'];

// Лимит OpenAI `tts-1` — 4096 символов на запрос. Значение по умолчанию держим равным ему.
const DEFAULT_MAX_CHARS = 4096;

export class TtsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
  }
}

// Без ограничения по времени зависший запрос к провайдеру оставил бы Mini App
// в состоянии «Подготавливаем аудио…» навсегда. У Piper запас больше: он грузит
// модель при каждом запуске и синтезирует часть целиком, без сети.
const REQUEST_TIMEOUT_MS = 60_000;
const PIPER_TIMEOUT_MS = 180_000;
const SILERO_TIMEOUT_MS = 300_000;

export function readTtsConfig(env = process.env) {
  const provider = (env.TTS_PROVIDER || 'silero').trim().toLowerCase();
  const macosSay = provider === 'macos-say';

  return {
    provider,
    apiKey: (env.TTS_API_KEY || '').trim(),
    baseUrl: (env.TTS_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
    model: (env.TTS_MODEL || 'tts-1').trim(),
    voice: (env.TTS_VOICE || '').trim() || (macosSay ? 'Milena' : 'alloy'),
    maxChars: Number(env.TTS_MAX_CHARS) > 0 ? Number(env.TTS_MAX_CHARS) : DEFAULT_MAX_CHARS,
    // Piper: путь задаётся явно, потому что системный python3 на macOS может быть
    // неподходящей версии — под неё нет колеса onnxruntime.
    piperPython: (env.TTS_PIPER_PYTHON || '').trim(),
    piperModel: (env.TTS_PIPER_MODEL || '').trim() || DEFAULT_PIPER_MODEL,
    piperDataDir: (env.TTS_PIPER_DATA_DIR || '').trim() || DEFAULT_PIPER_DATA_DIR,
    // Silero: свой venv с torch, отдельный от Piper.
    sileroPython: (env.TTS_SILERO_PYTHON || '').trim() || DEFAULT_SILERO_PYTHON,
    sileroScript: (env.TTS_SILERO_SCRIPT || '').trim() || DEFAULT_SILERO_SCRIPT,
    sileroModel: (env.TTS_SILERO_MODEL || '').trim() || DEFAULT_SILERO_MODEL,
    sileroSampleRate: Number(env.TTS_SILERO_SAMPLE_RATE) > 0 ? Number(env.TTS_SILERO_SAMPLE_RATE) : DEFAULT_SILERO_SAMPLE_RATE,
    sileroDataDir: (env.TTS_SILERO_DATA_DIR || '').trim() || DEFAULT_SILERO_DATA_DIR,
    sileroMaxChars:
      Number(env.TTS_SILERO_MAX_CHARS) > 0 ? Number(env.TTS_SILERO_MAX_CHARS) : DEFAULT_SILERO_MAX_CHARS,
    // Чем сжимать WAV в m4a. Пусто — по платформе: afconvert на macOS, ffmpeg на сервере.
    audioCompressor: (env.TTS_AUDIO_COMPRESSOR || '').trim(),
    // Слой нормализации текста перед синтезом; TTS_NORMALIZE=off отключает его целиком.
    normalize: (env.TTS_NORMALIZE || 'on').trim().toLowerCase() !== 'off',
  };
}

// Предел длины одной части у разных провайдеров разный: у Silero он свой и заметно меньше.
export function maxCharsFor(config, provider) {
  return provider === 'silero' ? config.sileroMaxChars : config.maxChars;
}

// Текст поста → текст, который уходит в синтез. Порядок слоёв: числа → латиница.
// Латинский слой идёт вторым: числовая нормализация уже развернула цифры в слова,
// а «B2B», «Node.js» и версии она намеренно не трогает, поэтому латинице достаётся
// текст без лишних чисел. После неё в тексте не остаётся латинских букв — значит
// просодия сможет разметить и те части, которые раньше уходили в Silero без SSML.
export function prepareText(config, text) {
  const source = String(text ?? '');
  return config.normalize ? normalizeLatin(normalizeText(source)) : source;
}

// Промежуточные шаги подготовки. Нужны и отладке, и слою просодии: он получает
// результат последнего шага, а не исходный текст.
export function prepareSteps(config, text) {
  const original = String(text ?? '');
  if (!config.normalize) {
    return { original, normalized: original, latinNormalized: original, prepared: original };
  }

  const normalized = normalizeText(original);
  const latinNormalized = normalizeLatin(normalized);
  return { original, normalized, latinNormalized, prepared: latinNormalized };
}

// Словарь ударений читается один раз за жизнь процесса: файл маленький, но
// перечитывать его на каждый пост незачем.
let pronunciationRuleset = null;

export function pronunciationRules() {
  if (!pronunciationRuleset) pronunciationRuleset = loadPronunciationRules();
  return pronunciationRuleset;
}

// Последний шаг перед провайдером: разметка (SSML или обычный текст) плюс ударения
// из словаря. Порядок слоёв — числа → латиница → просодия → произношение → Silero.
// Словарь затрагивает только слова из списка, остальной текст уходит как есть.
// Между просодией и произношением текст чистится под алфавит модели: иначе скобка или
// цифра в посте со «*» роняют синтез (см. text-sanitize.js).
export function chunkForTts(chunk, provider) {
  const withMarkup = chunkToProviderText(chunk, provider);
  const safe = provider === 'silero' ? sanitizeSileroSsml(withMarkup) : withMarkup;
  return applyPronunciation(safe, { rules: pronunciationRules().rules });
}

// Для отладки: что было, что уйдёт в синтез и на сколько частей это режется.
export function describePreparation(config, text, provider = config.provider) {
  const steps = prepareSteps(config, text);
  const chunks = splitText(steps.prepared, maxCharsFor(config, provider), { isolateLatin: provider === 'silero' });

  const changes = [];
  const prosodyChunks = chunks.map((chunk) => {
    const result = chunkForTts(chunk, provider);
    changes.push(...result.changes);
    return result.text;
  });

  return {
    original: steps.original,
    normalized: steps.normalized,
    latinNormalized: steps.latinNormalized,
    provider,
    maxChars: maxCharsFor(config, provider),
    chunks,
    prosody: prosodyChunks.join(provider === 'silero' ? '' : '\n\n'),
    prosodyChunks,
    pronunciation: changes,
    breaks: prosodyChunks.reduce((sum, chunk) => sum + (chunk.match(/<break time="/g) ?? []).length, 0),
  };
}

// Провайдер не подключён: pipeline есть, синтеза нет.
export function isTtsEnabled(config) {
  return config.provider !== 'none';
}

// Строка для лога при старте сервера: без ключа, только факт его наличия.
export function describeTts(config) {
  if (!isTtsEnabled(config)) {
    return 'провайдер не подключён (TTS_PROVIDER=none): POST /api/posts/:id/audio вернёт заглушку not_implemented';
  }

  if (config.provider === 'piper') {
    return `провайдер=piper, голос=${config.piperModel}, лимит=${config.maxChars} символов, ключ не требуется, каталог голосов ${config.piperDataDir}`;
  }

  if (config.provider === 'silero') {
    return `провайдер=silero, модель=${config.sileroModel}, ${config.sileroSampleRate} Гц, ключ не требуется`;
  }

  const details = `провайдер=${config.provider}, голос=${config.voice}, лимит=${config.maxChars} символов`;
  if (config.provider !== 'openai') return `${details}, ключ не требуется`;
  return config.apiKey ? `${details}, TTS_API_KEY найден` : `${details}, TTS_API_KEY не задан`;
}

// Готовность проверяется для конкретного провайдера: у piper и silero разные окружения.
export function isTtsConfigured(config, provider = config.provider) {
  if (!provider || provider === 'none') return false;
  if (provider === 'piper') return missingPiperParts(config).length === 0;
  if (provider === 'silero') return missingSileroParts(config).length === 0;
  if (provider === 'macos-say') return process.platform === 'darwin';
  if (provider === 'openai') return config.apiKey.length > 0;
  return false;
}

function missingSileroParts(config) {
  const missing = [];

  if (config.sileroPython.includes('/') && !existsSync(config.sileroPython)) {
    missing.push(`не найден python по пути ${config.sileroPython}`);
  }
  if (!existsSync(config.sileroScript)) {
    missing.push(`не найден скрипт ${config.sileroScript}`);
  }

  return missing;
}

// Что именно не готово у Piper — используется и для флага configured, и в тексте ошибки.
function missingPiperParts(config, voice = config.piperModel) {
  const missing = [];

  // Путь без слэша считается командой из PATH, такой файл проверять через existsSync нельзя.
  if (!config.piperPython) {
    missing.push('не задан TTS_PIPER_PYTHON (путь к python3 из venv с piper-tts)');
  } else if (config.piperPython.includes('/') && !existsSync(config.piperPython)) {
    missing.push(`не найден python по пути ${config.piperPython}`);
  }

  for (const file of [`${voice}.onnx`, `${voice}.onnx.json`]) {
    const full = path.join(config.piperDataDir, file);
    if (!existsSync(full)) missing.push(`не найден файл голоса ${full}`);
  }

  return missing;
}

// Голоса берутся из файловой системы: установленным считаем только тот,
// у которого рядом с моделью лежит её конфиг. Список нигде не задаётся руками.
export function listInstalledVoices(config) {
  let entries = [];
  try {
    entries = readdirSync(config.piperDataDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith('.onnx'))
    .map((name) => name.slice(0, -'.onnx'.length))
    .filter((voice) => existsSync(path.join(config.piperDataDir, `${voice}.onnx.json`)))
    .sort();
}

// Имя голоса приходит из запроса и попадает в путь к файлу, поэтому
// допускаем только безопасный набор символов.
export function isValidVoiceName(voice) {
  return typeof voice === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(voice);
}

// ru_RU-dmitri-medium → Dmitri
export function voiceLabel(voice) {
  const match = /^[a-z]{2}_[A-Z]{2}-(.+?)-(?:x_low|low|medium|high)$/.exec(String(voice));
  const raw = match ? match[1] : String(voice);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Пустой параметр означает голос по умолчанию: поведение без ?voice= не меняется.
export function resolveVoice(config, requested) {
  const voice = String(requested ?? '').trim() || config.piperModel;

  if (!isValidVoiceName(voice)) {
    throw new TtsError('unknown_voice', `Недопустимое имя голоса: ${voice}`);
  }

  const installed = listInstalledVoices(config);
  if (!installed.includes(voice)) {
    throw new TtsError(
      'unknown_voice',
      `Голос ${voice} не установлен. Доступны: ${installed.join(', ') || 'ни одного'}.`,
    );
  }

  return voice;
}

// Голоса Silero узнаём у самой модели и кэшируем на диск: загрузка torch занимает
// секунды, а список нужен на каждый запрос /api/voices.
export async function listSileroVoices(config) {
  const cacheFile = path.join(config.sileroDataDir, 'voices.json');

  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (Array.isArray(cached?.voices) && cached.voices.length > 0 && cached.model === config.sileroModel) {
      return cached.voices;
    }
  } catch {
    // кэша нет — спросим модель
  }

  const missing = missingSileroParts(config);
  if (missing.length > 0) throw new TtsError('tts_not_configured', `Silero не готов: ${missing.join('; ')}.`);

  // Список голосов тоже поднимает модель, поэтому идёт через ту же очередь, что и синтез.
  const { stdout } = await oneSynthesisAtATime(() =>
    execFileAsync(
      config.sileroPython,
      [config.sileroScript, '--list-voices', '--model', config.sileroModel],
      { timeout: SILERO_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    ),
  );

  // Среди вывода могут быть предупреждения torch — берём последнюю строку с JSON.
  const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).at(-1);
  const voices = JSON.parse(line ?? '{}')?.metadata?.speakers ?? [];
  if (voices.length === 0) {
    throw new TtsError('tts_failed', `Модель ${config.sileroModel} не сообщила ни одного голоса.`);
  }

  await mkdir(config.sileroDataDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ model: config.sileroModel, voices, cachedAt: new Date().toISOString() }, null, 2));
  return voices;
}

// Голос для конкретного провайдера. У piper это установленные модели, у silero — голоса модели,
// у остальных провайдеров голос задан в конфиге и не выбирается.
export async function resolveVoiceForProvider(config, provider, requested) {
  if (provider === 'piper') return resolveVoice(config, requested);
  if (provider === 'silero') {
    const voices = await listSileroVoices(config);
    const voice = String(requested ?? '').trim() || voices[0];
    if (!voices.includes(voice)) {
      throw new TtsError('unknown_voice', `Голос ${voice} не найден у silero. Доступны: ${voices.join(', ')}.`);
    }
    return voice;
  }
  return String(config.voice || 'default').trim();
}

// Ключ нельзя печатать и нельзя возвращать клиенту: прогоняем тексты ошибок через фильтр.
export function makeKeyScrubber(config) {
  return (value) => (config.apiKey ? String(value).split(config.apiKey).join('<TTS_API_KEY>') : String(value));
}

// Разбиение текста на части по границам предложений. Текст не обрезается:
// если предложение само длиннее лимита, оно делится по словам, а слово — по символам.
// Границы абзацев сохраняются: слой просодии расставляет по ним паузы.
// Латиница в SSML ломает разбор у Silero, поэтому такие предложения не смешиваем
// с остальными в одной части: иначе вся часть осталась бы без пауз.
const LATIN_LETTER = /[A-Za-z]/;

export function splitText(text, maxChars, { isolateLatin = false } = {}) {
  const normalized = String(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];
  // Раннего выхода для короткого текста нет: иначе изоляция латиницы не сработала бы
  // и короткий пост с ссылкой потерял бы паузы целиком. Одна часть получается сама собой.

  // Одиночные переводы строк внутри блока сохраняем: по ним просодия отличает
  // строку-заголовок от обычного текста. Абзацы разделяются пустой строкой.
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const block of blocks) {
    const sentences = block.match(/[^.!?…]+[.!?…]+[\s]*|[^.!?…]+$/g) ?? [block];
    let isFirstInBlock = true;

    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (!piece) continue;

      // Часть не должна смешивать латиницу и кириллицу: у них разный режим синтеза.
      if (isolateLatin && current && LATIN_LETTER.test(current) !== LATIN_LETTER.test(piece)) push();

      if (piece.length > maxChars) {
        push();
        for (const part of splitByWords(piece, maxChars)) chunks.push(part);
        isFirstInBlock = false;
        continue;
      }

      // Абзац внутри одной части отделяем переводом строки, между частями он не нужен.
      const separator = current ? (isFirstInBlock ? '\n\n' : ' ') : '';
      if ((current + separator + piece).length > maxChars) {
        push();
        current = piece;
      } else {
        current = current ? current + separator + piece : piece;
      }
      isFirstInBlock = false;
    }
  }
  push();

  return chunks;
}

function splitByWords(piece, maxChars) {
  const parts = [];
  let current = '';

  for (const word of piece.split(' ')) {
    if (word.length > maxChars) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxChars) parts.push(word.slice(i, i + maxChars));
      continue;
    }
    if ((current + ' ' + word).trim().length > maxChars) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }

  if (current) parts.push(current);
  return parts;
}

// Отмена операции: пользователь нажал «⏹ Остановить» или состояние сбросили через /reset.
// Отдельный код нужен, чтобы отмена не превращалась в «ошибка синтеза» и не показывалась
// пользователю как сбой.
function cancelledError() {
  return new TtsError('tts_cancelled', 'Синтез остановлен: операция отменена.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

// Общий дедлайн провайдера и внешняя отмена объединяются: побеждает то, что случится раньше.
function linkSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Синтез идёт по одному за раз. Каждая часть — это отдельный процесс Python с моделью:
// у Silero пиковая память такого процесса 1.16 ГБ, и два параллельных синтеза роняют
// машину с 2 ГБ (проверка — server/test-synthesis-queue.mjs). Очередь на уровне части,
// а не поста: второй пользователь вклинивается между частями первого, а не ждёт его
// пост целиком. На одной vCPU параллельность всё равно не ускоряет работу.
let synthesisChain = Promise.resolve();

function oneSynthesisAtATime(task) {
  const run = synthesisChain.then(
    () => task(),
    () => task(),
  );
  // Ошибка или отмена одной части не должна останавливать очередь для остальных.
  synthesisChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Синтез одной части текста. Возвращает { buffer, ext, contentType }.
// Единая точка выбора провайдера: { provider, voice }. Без них берётся конфиг.
// signal прерывает работу провайдера: у локальных это SIGTERM запущенному процессу.
export async function synthesizeChunk(config, text, { provider = config.provider, voice, signal } = {}) {
  throwIfAborted(signal);

  return oneSynthesisAtATime(() => {
    // Пока часть ждала очереди, пользователь мог нажать «Остановить»: тогда не начинаем.
    throwIfAborted(signal);
    if (provider === 'silero') return synthesizeWithSilero(config, text, voice, signal);
    if (provider === 'piper') return synthesizeWithPiper(config, text, voice ?? config.piperModel, signal);
    if (provider === 'macos-say') return synthesizeWithMacosSay(config, text, signal);
    if (provider === 'openai') return synthesizeWithOpenAi(config, text, signal);
    throw new TtsError('tts_not_implemented', `Провайдер TTS не подключён (provider=${provider}).`);
  });
}

// Парсер SSML у Silero не принимает латинские буквы: на «Часть I.» или «Apple»
// он падает с «Invalid XML format». Поэтому части с латиницей читаем без разметки —
// пауз в них не будет, зато текст не потеряется.
const LATIN = /[A-Za-z]/;

export function chunkToProviderText(chunk, provider) {
  if (provider !== 'silero') return chunk;
  return LATIN.test(chunk) ? chunk : buildSsml(chunk);
}

// Ниже этой длины часть уже не делим: если и она не влезает, это честная ошибка.
const MIN_CHUNK_CHARS = 120;

// Модель ограничена не символами, а длиной входа в токенах, поэтому плотный текст
// не влезает даже в разрешённые 800 символов. Сообщение об этом она отдаёт словами
// «Model couldn't generate your text, probably it's too long».
function isTooLong(error) {
  return /too long/i.test(String(error?.message ?? ''));
}

// Делим часть пополам: сначала по границе предложения рядом с серединой, затем по пробелу.
function splitInHalf(text) {
  const middle = Math.floor(text.length / 2);
  const from = Math.max(0, middle - 120);
  const sentence = text.slice(from).match(/^[^.!?…]*[.!?…]+\s/);
  if (sentence) {
    const at = from + sentence[0].length;
    if (at > 0 && at < text.length) return [text.slice(0, at).trim(), text.slice(at).trim()];
  }

  const space = text.lastIndexOf(' ', middle);
  if (space > 0) return [text.slice(0, space).trim(), text.slice(space + 1).trim()];
  return [text.slice(0, middle).trim(), text.slice(middle).trim()];
}

// Синтез всего текста: массив частей в порядке следования.
// Порядок слоёв: нормализация чисел → нарезка на части → просодия (паузы) → провайдер.
// Просодия размечается по частям: SSML нельзя разрезать, иначе теги останутся незакрытыми.
// onProgress вызывается перед каждой частью: по нему видно, что работа идёт.
export async function synthesize(config, text, { provider = config.provider, voice, signal, onProgress } = {}) {
  throwIfAborted(signal);

  const prepared = prepareText(config, text);
  const chunks = splitText(prepared, maxCharsFor(config, provider), { isolateLatin: provider === 'silero' });
  if (chunks.length === 0) throw new TtsError('tts_empty_text', 'Текст поста пуст — синтезировать нечего.');

  // Очередь частей может расти: если модель отказывается из-за длины, часть делится
  // пополам и половины встают на её место, поэтому обходим не массив, а очередь.
  const pending = [...chunks];
  const results = [];
  let processed = 0;

  while (pending.length > 0) {
    // Между частями операцию тоже можно отменить: следующую не начинаем.
    throwIfAborted(signal);
    const chunk = pending.shift();
    processed += 1;
    onProgress?.({ chunk: processed, chunks: processed + pending.length });

    const chunkText = chunkToProviderText(chunk, provider);
    const forTts = chunkForTts(chunk, provider).text;
    try {
      results.push(await synthesizeChunk(config, forTts, { provider, voice, signal }));
    } catch (error) {
      // Отмена не должна превращаться в повторный синтез той же части обычным текстом.
      if (error?.code === 'tts_cancelled') throw error;

      // Часть не влезла в модель — делим её и пробуем половины.
      if (provider === 'silero' && isTooLong(error) && chunk.length > MIN_CHUNK_CHARS) {
        const halves = splitInHalf(chunk).filter(Boolean);
        console.warn(`[tts] часть в ${chunk.length} символов не влезла в модель, делю на ${halves.map((half) => half.length).join(' и ')}`);
        pending.unshift(...halves);
        processed -= 1;
        continue;
      }

      // Страховка: если разметка почему-то не разобралась, читаем часть как обычный текст.
      if (provider === 'silero' && forTts !== chunk && /SSML|XML/i.test(String(error.message))) {
        console.warn(`[tts] SSML не разобрался, читаю часть без пауз: ${String(error.message).slice(-120)}`);
        results.push(await synthesizeChunk(config, chunk, { provider, voice, signal }));
        continue;
      }
      throw error;
    }
  }
  return results;
}

async function synthesizeWithOpenAi(config, text, signal) {
  if (!config.apiKey) {
    throw new TtsError(
      'tts_not_configured',
      'TTS_API_KEY не задан. Впишите ключ провайдера в файл .env в корне проекта (TTS_API_KEY=...) и перезапустите сервер.',
    );
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}/audio/speech`, {
      method: 'POST',
      signal: linkSignals(signal, REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: 'mp3',
      }),
    });
  } catch (error) {
    if (isAbort(error, signal)) throw cancelledError();
    const detail =
      error.name === 'TimeoutError'
        ? `провайдер не ответил за ${REQUEST_TIMEOUT_MS / 1000} с`
        : error.message;
    throw new TtsError('tts_unreachable', `Не удалось обратиться к TTS-провайдеру: ${detail}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      // Тело не JSON — оставляем как есть.
    }
    throw new TtsError('tts_failed', `Провайдер вернул ${response.status}: ${detail || 'без описания'}`);
  }

  return { buffer: Buffer.from(await response.arrayBuffer()), ext: 'mp3', contentType: 'audio/mpeg' };
}

// Провайдеры пишут WAV, а Mini App получает m4a: он в разы меньше и играется в вебвью.
// Сжиматель выбирается по платформе — на macOS это системный afconvert, на сервере ffmpeg.
// Значение переопределяется TTS_AUDIO_COMPRESSOR, если в образе оказался только один из них.
const COMPRESSORS = {
  afconvert: { bin: 'afconvert', args: (wav, m4a) => ['-f', 'm4af', '-d', 'aac', wav, m4a] },
  // 64 кбит/с моно хватает речи: части по 800 символов весят десятки килобайт,
  // а это важно, когда Mini App тянет их по мобильной сети.
  ffmpeg: {
    bin: 'ffmpeg',
    args: (wav, m4a) => ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '64k', m4a],
  },
};

export function pickCompressor(explicit) {
  const name = String(explicit || '').trim().toLowerCase() || (process.platform === 'darwin' ? 'afconvert' : 'ffmpeg');
  const compressor = COMPRESSORS[name];
  if (!compressor) {
    throw new TtsError(
      'tts_not_configured',
      `Неизвестный сжиматель аудио (${name}). Доступны: ${Object.keys(COMPRESSORS).join(', ')}.`,
    );
  }
  return { name, ...compressor };
}

async function compressToM4a(config, wav, m4a, signal) {
  const compressor = pickCompressor(config.audioCompressor);
  try {
    await execFileAsync(compressor.bin, compressor.args(wav, m4a), {
      timeout: PIPER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    });
    return { buffer: await readFile(m4a), ext: 'm4a', contentType: 'audio/mp4' };
  } catch (error) {
    if (isAbort(error, signal)) throw cancelledError();
    const detail = String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
    const hint = error.code === 'ENOENT' ? ` Программа ${compressor.bin} не найдена в PATH.` : '';
    throw new TtsError('tts_failed', `Сжатие аудио (${compressor.name}) не удалось: ${detail}.${hint}`);
  }
}

// Локальный синтез Piper: python из venv запускает пакет piper-tts и пишет WAV,
// дальше сжиматель превращает его в m4a.
async function synthesizeWithPiper(config, text, voice = config.piperModel, signal) {
  const missing = missingPiperParts(config, voice);
  if (missing.length > 0) {
    throw new TtsError('tts_not_configured', `Piper не готов: ${missing.join('; ')}.`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'tg-reader-piper-'));
  const wav = path.join(dir, 'chunk.wav');
  const m4a = path.join(dir, 'chunk.m4a');

  // Один внешний finally на все пути выхода: каталог убирается и при отмене,
  // и при ошибке первой ступени — иначе временные файлы копились бы после каждой неудачи.
  try {
    try {
      // Аргументы передаются массивом, без shell: текст поста не может стать командой.
      // После «--» идёт сам текст, поэтому он не спутается с флагами piper.
      await execFileAsync(
        config.piperPython,
        ['-m', 'piper', '-m', voice, '-f', wav, '--data-dir', config.piperDataDir, '--', text],
        { timeout: PIPER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
      );
    } catch (error) {
      if (isAbort(error, signal)) throw cancelledError();
      const detail = String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
      const reason = error.killed ? `превышен таймаут ${PIPER_TIMEOUT_MS / 1000} с` : detail;
      throw new TtsError('tts_failed', `Локальный синтез (piper) не удался: ${reason}`);
    }

    return await compressToM4a(config, wav, m4a, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Локальный синтез Silero: python из venv .venv-silero запускает silero_tts_cli.py,
// тот пишет WAV, дальше сжиматель превращает его в m4a — как и у piper.
async function synthesizeWithSilero(config, text, voice, signal) {
  const missing = missingSileroParts(config);
  if (missing.length > 0) {
    throw new TtsError('tts_not_configured', `Silero не готов: ${missing.join('; ')}.`);
  }

  const voices = await listSileroVoices(config);
  const selected = String(voice ?? '').trim() || voices[0];
  if (!voices.includes(selected)) {
    throw new TtsError('unknown_voice', `Голос ${selected} не найден у silero. Доступны: ${voices.join(', ')}.`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'tg-reader-silero-'));
  const wav = path.join(dir, 'chunk.wav');
  const m4a = path.join(dir, 'chunk.m4a');

  // Silero принимает SSML отдельным аргументом, поэтому режим выбираем по содержимому:
  // разметка приходит из text-prosody.js, обычный текст — когда разметка не применялась.
  const isSsml = String(text).trimStart().startsWith('<speak');

  // Один внешний finally на все пути выхода: каталог убирается и при отмене,
  // и при ошибке первой ступени — иначе временные файлы копились бы после каждой неудачи.
  try {
    try {
      // Аргументы передаются массивом, без shell: текст поста не может стать командой.
      // signal убивает запущенный процесс синтеза: это и есть «⏹ Остановить».
      await execFileAsync(
        config.sileroPython,
        [
          config.sileroScript,
          '--model',
          config.sileroModel,
          '--voice',
          selected,
          '--sample-rate',
          String(config.sileroSampleRate),
          isSsml ? '--ssml-text' : '--text',
          text,
          '--out',
          wav,
        ],
        { timeout: SILERO_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
      );
    } catch (error) {
      if (isAbort(error, signal)) throw cancelledError();
      const detail = String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
      const reason = error.killed ? `превышен таймаут ${SILERO_TIMEOUT_MS / 1000} с` : detail;
      // Частая причина отказа — слишком длинная часть: подсказываем, где это настраивается.
      const hint = detail.includes('too long')
        ? ` Часть длиннее, чем принимает Silero; уменьшите TTS_SILERO_MAX_CHARS (сейчас ${config.sileroMaxChars}).`
        : '';
      throw new TtsError('tts_failed', `Локальный синтез (silero) не удался: ${reason}${hint}`);
    }

    return await compressToM4a(config, wav, m4a, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function synthesizeWithMacosSay(config, text, signal) {
  if (process.platform !== 'darwin') {
    throw new TtsError('tts_not_configured', 'Провайдер macos-say доступен только на macOS.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'tg-reader-say-'));
  const file = path.join(dir, 'chunk.m4a');
  try {
    // Аргументы передаются массивом, без shell: текст поста не может стать командой.
    await execFileAsync(
      'say',
      ['-v', config.voice, '-o', file, '--file-format=m4af', '--data-format=aac', text],
      { signal },
    );
    return { buffer: await readFile(file), ext: 'm4a', contentType: 'audio/mp4' };
  } catch (error) {
    if (isAbort(error, signal)) throw cancelledError();
    throw new TtsError('tts_failed', `Локальный синтез (say) не удался: ${error.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
