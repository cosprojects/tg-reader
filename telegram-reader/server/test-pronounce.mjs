// Проверка слоя произношения: node server/test-pronounce.mjs
//
// Три части:
//   1. словарь и правки текста: что меняется, что обязано остаться нетронутым;
//   2. место в pipeline: разметка появляется после просодии, внутри <speak>;
//   3. настоящий Silero: знак «+» действительно меняет звук в том же пути,
//      которым пользуется синтез поста.
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from './src/env.js';
import { cacheDir, readManifest } from './src/audio-store.js';
import { applyPronunciation, loadPronunciationRules } from './src/text-pronounce.js';
import { describePreparation, isTtsConfigured, readTtsConfig, resolveVoiceForProvider, synthesizeChunk, synthesize } from './src/tts.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

// --- часть 1: словарь и правки ------------------------------------------------------------

function testDictionary() {
  console.log('— словарь и правки текста —');

  const { rules, problems, file } = loadPronunciationRules();
  check('словарь читается и не содержит ошибок', problems.length === 0, problems.join('; '));
  check('в словаре есть правила', rules.length > 0, `правил: ${rules.length}`);
  check('файл словаря лежит рядом с кодом сервера', file.endsWith('pronunciation_rules.json'), file);
  console.log(`  словарь: ${file}, правил: ${rules.length}`);

  const mark = (text) => applyPronunciation(text, { rules }).text;

  // Формы слов из словаря.
  const cases = [
    ['обеспечение', 'обеспеч+ение'],
    ['обеспечения', 'обеспеч+ения'],
    ['обеспечением', 'обеспеч+ением'],
    ['Обеспечение', 'Обеспеч+ение'],
    ['ОБЕСПЕЧЕНИЕ', 'ОБЕСПЕЧ+ЕНИЕ'],
    ['уведомить', 'увед+омить'],
    ['уведомит', 'увед+омит'],
    ['Красивее, чем раньше', 'Крас+ивее, чем раньше'],
    ['щавель и щавеля', 'щав+ель и щав+еля'],
    ['некролог', 'некрол+ог'],
    ['маркетинга', 'м+аркетинга'],
    ['пломбировать', 'пломбир+овать'],
    ['банты и бантик', 'б+анты и б+антик'],
  ];

  for (const [input, expected] of cases) {
    check(`«${input}» → «${expected}»`, mark(input) === expected, mark(input));
  }

  // Слова, которые модель произносит верно, словарь не трогает: правка уже
  // правильного произношения — лишний риск.
  const untouched = [
    'договор', 'звонит', 'каталог', 'баловать', 'средства', 'квартал', 'туфля',
    'обеспеченный', 'обеспечить', 'обеспечивать', 'уведомление', 'покрасивее',
    'Подробнее: Ссылка в 2026 году', 'OpenAI API',
  ];

  for (const word of untouched) {
    check(`«${word}» не меняется`, mark(word) === word, mark(word));
  }

  // Одновременные правки и регистр.
  const sentence = 'Наше обеспечение и обеспечения работы: маркетинг, уведомит клиентов.';
  check(
    'все слова словаря в предложении размечены',
    mark(sentence) === 'Наше обеспеч+ение и обеспеч+ения работы: м+аркетинг, увед+омит клиентов.',
    mark(sentence),
  );

  const changes = applyPronunciation(sentence, { rules }).changes;
  check('правки перечислены для лога', changes.length === 4, JSON.stringify(changes));
  check(
    'лог показывает пару «было → стало»',
    changes[0].word === 'обеспечение' && changes[0].marked === 'обеспеч+ение',
    JSON.stringify(changes[0]),
  );

  // Ложных срабатываний внутри слов быть не должно.
  check('«микрообеспечение» не ловится', mark('микрообеспечение') === 'микрообеспечение', mark('микрообеспечение'));
  check('«полуобеспечение» не ловится', mark('полуобеспечение') === 'полуобеспечение', mark('полуобеспечение'));
  check('«зауведомить» не ловится', mark('зауведомить') === 'зауведомить', mark('зауведомить'));

  // Битый словарь не должен ронять синтез: слой просто ничего не меняет.
  const broken = applyPronunciation('обеспечение', { rules: [] });
  check('без правил текст не меняется', broken.text === 'обеспечение' && broken.changes.length === 0);
}

// --- часть 2: место в pipeline ------------------------------------------------------------

function testPipelinePlacement() {
  console.log('\n— место в pipeline —');

  const config = readTtsConfig();
  const text = 'Обеспечение проекта и маркетинг в 2026 году.';
  const prepared = describePreparation(config, text, 'silero');

  check('числовая нормализация работает как раньше', /две тысячи двадцать шестом/.test(prepared.normalized), prepared.normalized);
  check('слой произношения идёт после латиницы', prepared.latinNormalized === 'Обеспечение проекта и маркетинг в две тысячи двадцать шестом году.', prepared.latinNormalized);
  check('разметка ударений попала в текст для Silero', /Обеспеч\+ение/.test(prepared.prosody) && /м\+аркетинг/.test(prepared.prosody), prepared.prosody);
  check('разметка внутри SSML, а не вместо неё', /<speak>/.test(prepared.prosody) && prepared.prosody.includes('Обеспеч+ение'), prepared.prosody);
  check('правки перечислены в подготовке', prepared.pronunciation.length === 2, JSON.stringify(prepared.pronunciation));
  check('слова вне словаря остались без «+»', !/проекта\+|в\+ /.test(prepared.prosody), prepared.prosody);
}

// --- часть 3: настоящий Silero ------------------------------------------------------------

async function testRealVoice() {
  console.log('\n— проверка голосом —');

  const config = readTtsConfig();
  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен в этом окружении');
    return;
  }

  // Знак «+» меняет звук в том же пути, которым пользуется синтез поста:
  // сравниваем одну и ту же фразу с разметкой и без неё.
  const plain = await synthesizeChunk(config, 'Обеспечение проекта готово.', { provider: 'silero' });
  const marked = await synthesizeChunk(config, 'Обеспеч+ение проекта готово.', { provider: 'silero' });
  check(
    'разметка ударения меняет звук',
    !plain.buffer.equals(marked.buffer),
    `одинаковые файлы: ${plain.buffer.length} и ${marked.buffer.length} байт`,
  );

  // Та же фраза через pipeline: слой сам ставит разметку, синтез проходит целиком.
  const cacheBefore = readdirSync(cacheDir());
  let results = null;
  let error = null;
  try {
    results = await synthesize(config, 'Обеспечение проекта и маркетинг готовы.', { provider: 'silero' });
  } catch (caught) {
    error = caught;
  }
  check('pipeline с разметкой синтезируется без ошибок', error === null, `${error?.code}: ${error?.message}`);
  check('получено аудио', Boolean(results?.[0]?.buffer?.length), JSON.stringify(results?.map((r) => r.buffer.length)));
  check('файлы в кэше тест не создавал', readdirSync(cacheDir()).join(',') === cacheBefore.join(','));

  // Полный путь с постом: важна не только фраза, но и запись в кэш.
  const { generateAudioForPost } = await import('./src/generate.js');
  const { savePost } = await import('./src/store.js');
  const post = savePost('Обеспечение и маркетинг: уведомит клиентов о бантах.', undefined, 'test');
  const voice = await resolveVoiceForProvider(config, 'silero', undefined);
  const { manifest } = await generateAudioForPost(config, post, { provider: 'silero', voice });
  check('пост с проблемными словами доходит до кэша', Boolean(manifest?.chunks?.length), JSON.stringify(manifest?.chunks?.length));
  check('аудио в кэше появилось', Boolean(await readManifest(post.id, 'silero', voice)));

  for (const name of readdirSync(cacheDir()).filter((entry) => !cacheBefore.includes(entry))) {
    rmSync(path.join(cacheDir(), name), { recursive: true, force: true });
  }
}

async function main() {
  loadEnv();
  testDictionary();
  testPipelinePlacement();
  await testRealVoice();

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
