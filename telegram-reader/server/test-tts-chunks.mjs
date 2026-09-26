// Проверка длинных постов: node server/test-tts-chunks.mjs
//
// Модель Silero ограничена не символами, а длиной входа в токенах: плотный текст
// не влезает и в 800 символов и падает с «Model couldn't generate your text,
// probably it's too long» — из-за этого длинные посты не озвучивались целиком.
// Теперь такая часть делится пополам и синтезируется по половинам.
//
// Замеры предела на этом тексте: 675 символов — проходит, 810 — уже отказ.
// Поэтому проверяем два случая: обычный пост (части 800, всё проходит) и заведомо
// длинные части (лимит задан в 1000 — они обязаны упереться в предел и поделиться).
import { loadEnv } from './src/env.js';
import { isTtsConfigured, readTtsConfig, splitText, synthesize, maxCharsFor } from './src/tts.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

// Плотный текст: много коротких слов и знаков, как в списках из Telegram.
const PHRASE =
  'аспекты непостоянства, страдания, пустоты и бессамостности, причина страсти, гнева и заблуждения, прекращение покоя, нирваны и тишины, ';
const DENSE = `${PHRASE.repeat(9)}конец.`;

function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => {
    lines.push(args.join(' '));
    original(...args);
  };
  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
}

async function run(text, config) {
  const warnings = captureWarnings();
  let results = null;
  let error = null;
  try {
    results = await synthesize(config, text, { provider: 'silero' });
  } catch (caught) {
    error = caught;
  } finally {
    warnings.restore();
  }
  return { results, error, warnings: warnings.lines.filter((line) => /не влезла в модель/.test(line)) };
}

async function main() {
  loadEnv();
  const config = readTtsConfig();

  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен');
    process.exit(0);
  }

  // 1. Обычный пост: плотный текст длиннее одной части, нарезка по 800 символов.
  const parts = splitText(DENSE.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(), maxCharsFor(config, 'silero'), { isolateLatin: true });
  console.log(`  плотный текст ${DENSE.length} символов, частей по 800: ${parts.length}`);

  const normal = await run(DENSE, config);
  check('длинный плотный пост синтезируется целиком', normal.error === null, `${normal.error?.code}: ${normal.error?.message}`);
  check('аудио есть на каждую часть', normal.results?.length >= parts.length && normal.results.every((part) => part.buffer.length > 1000), `частей: ${normal.results?.length}`);

  // 2. Заведомо длинные части: лимит 1000 символов гарантированно выше предела модели,
  //    поэтому части обязаны поделиться. Так проверяется сам механизм деления.
  const tight = { ...config, sileroMaxChars: 1000 };
  const long = await run(DENSE, tight);
  const initial = splitText(DENSE.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(), 1000, { isolateLatin: true });

  check('части выше предела модели всё равно озвучиваются', long.error === null, `${long.error?.code}: ${long.error?.message}`);
  check('механизм деления сработал', long.warnings.length > 0, `предупреждений: ${long.warnings.length}`);
  check('частей стало больше, чем было', (long.results?.length ?? 0) > initial.length, `было ${initial.length}, стало ${long.results?.length}`);
  check('каждая часть не пустая', long.results?.every((part) => part.buffer.length > 1000), JSON.stringify(long.results?.map((part) => part.buffer.length)));

  if (long.warnings.length > 0) console.log(`  пример деления: ${long.warnings[0].slice(0, 100)}`);

  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
