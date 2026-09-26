// Проверка очистки текста под алфавит Silero: node server/test-sanitize.mjs
//
// Поводом был реальный сбой: пост с markdown-разметкой («###», «**») и скобками падал
// целиком с KeyError: '(' — при наличии «*» модель берёт текст без своего фильтра символов.
import { loadEnv } from './src/env.js';
import { sanitizeSileroSsml, sanitizeSileroText } from './src/text-sanitize.js';
import { describePreparation, isTtsConfigured, readTtsConfig, synthesize } from './src/tts.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

// Алфавит модели: всё, что вне него, роняет синтез на ветке «focus words».
const ALLOWED = /^[а-яёА-ЯЁ!,\-.:;?–—… +]*$/;

// Текст, максимально похожий на сбойный пост: markdown-заголовки и выделение,
// списки с цифрами, скобки, тире, многоточие.
const BROKEN = [
  '### четыре. Пять духовных качеств (индрийя)',
  'Это **важно**: 1. Вера (саддха) – доверие к учению.',
  '2. Энергия (вирия) — усилие в практике… 3. Осознанность (сати).',
  'Цифры: 2026 год, 15%, 25.09.2026, id 1234567.',
].join('\n\n');

function testSanitizer() {
  console.log('— очистка текста —');

  const clean = sanitizeSileroText(BROKEN);
  check('в очищенном тексте нет запрещённых символов', ALLOWED.test(clean), JSON.stringify(clean.slice(0, 120)));
  check('скобки, звёздочки и решётки удалены', !/[()*#\[\]{}«»"]/.test(clean), clean.slice(0, 120));
  check('цифры удалены', !/\d/.test(clean), clean);
  check('русский текст сохранён', /Пять духовных качеств индрийя/.test(clean), clean.slice(0, 80));
  check('знаки препинания модели сохранены', /[,.:;?]/.test(clean));
  check('переводы строк заменены пробелами, слова не склеены', /качеств индрийя/.test(clean) && !/\n/.test(clean), JSON.stringify(clean.slice(0, 80)));

  // Знак ударения из словаря произношения должен пережить очистку.
  check('знак ударения сохраняется', sanitizeSileroText('обеспеч+ение проекта') === 'обеспеч+ение проекта', sanitizeSileroText('обеспеч+ение проекта'));
  check('плюс без гласной удаляется', sanitizeSileroText('два + два = 2+2') === 'два два ', sanitizeSileroText('два + два = 2+2'));
  check('латиница и эмодзи удаляются', sanitizeSileroText('OpenAI API 🚀') === ' ', JSON.stringify(sanitizeSileroText('OpenAI API 🚀')));

  const ssml = sanitizeSileroSsml('<speak>### Заголовок (вставка)<break time="700ms"/>Текст *с выделением*.</speak>');
  check('теги SSML не повреждены', ssml.startsWith('<speak>') && ssml.endsWith('</speak>') && ssml.includes('<break time="700ms"/>'), ssml);
  check('внутри SSML не осталось запрещённых символов', ALLOWED.test(ssml.replace(/<\/?[a-z]+[^>]*>/g, '')), ssml);
}

async function testPipeline() {
  console.log('\n— pipeline и настоящий Silero —');

  const config = readTtsConfig();
  const prepared = describePreparation(config, BROKEN, 'silero');

  check('просодия сохранила паузы абзацев', /<break time="/.test(prepared.prosody), prepared.prosody.slice(0, 160));
  check('заголовок распознан до очистки (пауза после него есть)', (prepared.breaks ?? 0) > 0, String(prepared.breaks));
  check('в тексте для модели нет запрещённых символов', ALLOWED.test(prepared.prosody.replace(/<\/?[a-z]+[^>]*>/g, '')), prepared.prosody.slice(0, 200));

  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск синтеза: Silero не настроен');
    return;
  }

  // Тот самый случай, который падал: со звёздочкой и скобкой.
  const cases = [
    ['markdown-пост со скобками и цифрами', BROKEN],
    ['звёздочка и цифры', 'текст *важно* 123 цифры (вставка)'],
  ];

  for (const [name, text] of cases) {
    let error = null;
    let result = null;
    try {
      result = await synthesize(config, text, { provider: 'silero' });
    } catch (caught) {
      error = caught;
    }
    check(`синтез проходит: ${name}`, error === null && (result?.[0]?.buffer?.length ?? 0) > 1000, `${error?.code}: ${error?.message}`);
  }
}

async function main() {
  loadEnv();
  testSanitizer();
  await testPipeline();
  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
