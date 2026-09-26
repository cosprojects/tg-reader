// Кэш сгенерированного аудио: <AUDIO_CACHE_DIR>/<postId>/chunk-000.mp3 + manifest.json.
// PoC: файлы лежат на локальном диске. На Vercel файловая система эфемерна,
// поэтому при деплое backend потребуется внешнее хранилище (см. docs/tts.md).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Провайдер и голос тоже приходят снаружи и участвуют в пути, поэтому проверяем и их.
const VOICE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const PROVIDER_PATTERN = /^[a-z0-9-]{1,32}$/;

const rootDir = path.resolve(process.env.AUDIO_CACHE_DIR || path.join(here, '..', '.audio-cache'));

// Кэш разложен по тройке «пост + провайдер + голос»: у одного поста может быть
// несколько озвучек, и голоса разных провайдеров не должны смешиваться.
// Идентификатор поста приходит из URL, поэтому путь собирается только из него
// и только после проверки формата: подставить «../» вместо id нельзя.
function postDir(postId, provider, voice) {
  if (!UUID_PATTERN.test(String(postId))) return null;
  if (!PROVIDER_PATTERN.test(String(provider))) return null;
  if (!VOICE_PATTERN.test(String(voice))) return null;
  return path.join(rootDir, String(postId), String(provider), String(voice));
}

// Защита от повторной генерации: пока для поста идёт синтез, второй запрос ждёт тот же результат
// (React StrictMode в dev-режиме монтирует компоненты дважды и шлёт два одинаковых POST).
const inFlight = new Map();

export function generateOnce(key, factory) {
  const running = inFlight.get(key);
  if (running) return running;

  const promise = factory().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export async function readManifest(postId, provider, voice) {
  const dir = postDir(postId, provider, voice);
  if (!dir) return null;

  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (!Array.isArray(raw?.chunks) || raw.chunks.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveAudio(postId, provider, voice, results) {
  const dir = postDir(postId, provider, voice);
  if (!dir) throw new Error('invalid post id, provider or voice');

  await mkdir(dir, { recursive: true });

  const chunks = [];
  for (const [index, result] of results.entries()) {
    const file = `chunk-${String(index).padStart(3, '0')}.${result.ext}`;
    await writeFile(path.join(dir, file), result.buffer);
    chunks.push({ file, ext: result.ext, contentType: result.contentType, bytes: result.buffer.length });
  }

  const manifest = { postId, provider, voice, chunks, createdAt: new Date().toISOString() };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Имя файла берётся из манифеста, а не из запроса: наружу отдаём только то, что сами записали.
export async function resolveChunk(postId, provider, voice, index) {
  const manifest = await readManifest(postId, provider, voice);
  const chunk = manifest?.chunks?.[index];
  const dir = postDir(postId, provider, voice);
  if (!chunk || !dir) return null;

  const full = path.join(dir, chunk.file);
  if (!full.startsWith(dir + path.sep)) return null;
  return { path: full, contentType: chunk.contentType };
}

export function cacheDir() {
  return rootDir;
}
