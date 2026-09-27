// Проверка, что синтез частей идёт по одному за раз.
// Запуск: node server/test-synthesis-queue.mjs
//
// Смысл проверки: каждый синтез части — это отдельный Python-процесс с моделью, около
// 1.16 ГБ пиковой памяти. Два одновременно на машине с 2 ГБ означают падение по памяти,
// поэтому часть считается «в работе» ровно одна. Признак работы — временный каталог
// tg-reader-silero-*, который живёт ровно столько, сколько работает процесс.
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from './src/env.js';
import { cacheDir, readManifest } from './src/audio-store.js';
import { generateAudioForPost } from './src/generate.js';
import { isTtsConfigured, readTtsConfig, resolveVoiceForProvider } from './src/tts.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

function tempSileroDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('tg-reader-silero-'));
}

// Часть такой длины синтезируется около секунды: достаточно, чтобы наблюдатель успел
// заметить два каталога, если синтезы действительно идут параллельно.
function postText(marker) {
  return [
    `Проверка очереди синтеза, пост ${marker}.`,
    'Текст должен быть достаточно длинным, чтобы синтез занял заметное время:',
    'модель загружается перед каждой частью, поэтому каталог живёт около секунды.',
    'Если два таких поста считаются одновременно, на диске появятся два каталога.',
  ].join(' ');
}

async function main() {
  loadEnv();
  console.log('— синтез частей по одному за раз —');

  const config = readTtsConfig();
  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен в этом окружении');
    process.exit(0);
  }

  const provider = 'silero';
  const voice = await resolveVoiceForProvider(config, provider, undefined);
  const posts = [
    { id: randomUUID(), text: postText('первый') },
    { id: randomUUID(), text: postText('второй') },
  ];

  const baseline = new Set(tempSileroDirs());
  let maxConcurrent = 0;
  const watcher = setInterval(() => {
    const running = tempSileroDirs().filter((name) => !baseline.has(name)).length;
    if (running > maxConcurrent) maxConcurrent = running;
  }, 20);

  let error = null;
  try {
    // Оба поста запускаются разом: именно так ведут себя два пользователя в боте.
    await Promise.all(posts.map((post) => generateAudioForPost(config, post, { provider, voice })));
  } catch (caught) {
    error = caught;
  } finally {
    clearInterval(watcher);
  }

  check('оба поста озвучены', error === null, `${error?.name}: ${error?.message}`);

  const manifests = await Promise.all(posts.map((post) => readManifest(post.id, provider, voice)));
  check(
    'у обоих постов есть аудио',
    manifests.every((manifest) => manifest?.chunks?.length > 0),
    manifests.map((manifest) => Boolean(manifest)).join(', '),
  );
  check(
    'одновременно работал один синтез',
    maxConcurrent <= 1,
    `максимум одновременно работающих: ${maxConcurrent}`,
  );
  check('временные каталоги убраны', tempSileroDirs().length <= baseline.size, `каталогов: ${tempSileroDirs().length}`);

  for (const post of posts) rmSync(path.join(cacheDir(), post.id), { recursive: true, force: true });

  await testCancelWhileQueued(config);

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

// Отмена поста, который ждёт своей очереди: его часть не должна начаться вовсе,
// а пост, который уже считается, обязан досчитаться как обычно.
async function testCancelWhileQueued(config) {
  console.log('\n— «Остановить» на посте, который стоит в очереди —');

  const provider = 'silero';
  const voice = await resolveVoiceForProvider(config, provider, undefined);
  const running = { id: randomUUID(), text: postText('в работе') };
  const waiting = { id: randomUUID(), text: postText('в очереди') };

  const controller = new AbortController();
  const runningPromise = generateAudioForPost(config, running, { provider, voice });
  const waitingPromise = generateAudioForPost(config, waiting, { provider, voice, signal: controller.signal });

  // Отменяем, пока первая часть ещё считается: второй пост в это время ждёт очереди.
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();

  const [runningResult, waitingError] = await Promise.all([
    runningPromise.then(
      (result) => result,
      (caught) => caught,
    ),
    waitingPromise.then(
      () => null,
      (caught) => caught,
    ),
  ]);

  check(
    'пост в работе досчитался, несмотря на отмену соседнего',
    Boolean(runningResult?.manifest?.chunks?.length),
    String(runningResult?.name ?? runningResult?.message ?? ''),
  );
  check(
    'отменённый в очереди пост получил tts_cancelled',
    waitingError?.code === 'tts_cancelled',
    `${waitingError?.name}: ${waitingError?.message}`,
  );
  check(
    'отменённый в очереди пост не оставил аудио',
    (await readManifest(waiting.id, provider, voice)) === null,
  );

  for (const post of [running, waiting]) rmSync(path.join(cacheDir(), post.id), { recursive: true, force: true });
}

await main();
