// Проверка темпа и пауз: node server/test-prosody.mjs
//
// Замеры на голосе aidar показали: без разметки модель читает ≈6.2 слога в секунду —
// это быстрее естественной русской речи (5.0–5.5), поэтому слова сливаются. Слой
// просодии добавляет <prosody rate="88%"> и паузы <break>; здесь проверяем, что тег
// на месте, что паузы остались внутри него и что синтез действительно стал медленнее.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv } from './src/env.js';
import { PAUSE_MS, SPEECH_RATE, buildSsml, describeProsody } from './src/text-prosody.js';
import { describePreparation, isTtsConfigured, readTtsConfig, synthesizeChunk } from './src/tts.js';

// Длительность m4a читаем через afinfo: по размеру файла она считается неточно,
// а темп речи нужно сравнивать с секундами.
function audioSeconds(buffer) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prosody-test-'));
  const file = path.join(dir, 'chunk.m4a');
  try {
    writeFileSync(file, buffer);
    const info = execFileSync('afinfo', [file], { encoding: 'utf8' });
    const match = info.match(/estimated duration:\s*([\d.]+)\s*sec/i);
    return match ? Number(match[1]) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

const syllables = (text) => (String(text).toLowerCase().match(/[аеёиоуыэюя]+/g) ?? []).length;

const TEXT = [
  'Технологии меняются быстро. Ещё вчера мы обсуждали нейросети в лабораториях, а сегодня они пишут тексты и озвучивают посты в Telegram.',
  '',
  'Что это значит для продукта? Пользователь привыкает к скорости: если ответ приходит через десять секунд, он уже отвлёкся и ушёл в другую вкладку.',
].join('\n');

function testStructure() {
  console.log('— разметка —');

  const ssml = buildSsml(TEXT);
  check('темп задан тегом prosody', ssml.startsWith(`<speak><prosody rate="${SPEECH_RATE}">`), ssml.slice(0, 80));
  check('тег закрыт', ssml.endsWith('</prosody></speak>'), ssml.slice(-40));
  check('паузы абзацев остались внутри тега', ssml.includes(`<break time="${PAUSE_MS.paragraph}ms"/>`), ssml);

  const described = describeProsody(TEXT);
  check('паузы на месте', described.breaks >= 1, JSON.stringify(described.breaks));
  check('просодия не пустая', described.prosody.length > TEXT.length, described.prosody.slice(0, 100));

  // Слой очистки текста не должен съедать тег темпа.
  const prepared = describePreparation(readTtsConfig(), TEXT, 'silero');
  check('темп доходит до синтеза', /<prosody rate="88%">/.test(prepared.prosody), prepared.prosody.slice(0, 80));
  check('в тексте для модели нет запрещённых символов', !/[()*#\d]/.test(prepared.prosody.replace(/<\/?[a-z]+[^>]*>/g, '')));
}

async function testRealTempo() {
  console.log('\n— темп на настоящем Silero —');

  const config = readTtsConfig();
  if (!isTtsConfigured(config, 'silero')) {
    console.log('… пропуск: Silero не настроен');
    return;
  }

  // Берём текст, подготовленный слоями (латиница и запрещённые символы уже убраны),
  // и сравниваем один и тот же фрагмент с темпом и без него.
  const prepared = describePreparation(config, TEXT, 'silero');
  const slowed = prepared.prosodyChunks[0];
  const plain = slowed.replace(/<\/?prosody[^>]*>/g, '');

  check('подготовленная часть размечена темпом', /<prosody rate="88%">/.test(slowed), slowed.slice(0, 80));

  const faster = await synthesizeChunk(config, plain, { provider: 'silero' });
  const slower = await synthesizeChunk(config, slowed, { provider: 'silero' });

  // Размер файла пропорционален длительности: 48 кГц, моно, AAC.
  const ratio = Number((slower.buffer.length / faster.buffer.length).toFixed(3));
  check('замедление действительно удлиняет аудио', ratio > 1.05, `отношение ${ratio}`);

  const slowSeconds = audioSeconds(slower.buffer);
  const fastSeconds = audioSeconds(faster.buffer);
  const tempo = slowSeconds ? Number((syllables(TEXT) / slowSeconds).toFixed(2)) : 0;
  console.log(`  слогов ${syllables(TEXT)}: без темпа ${fastSeconds} с, с темпом ${slowSeconds} с → ${tempo} слог/с`);
  check('длительность читается', Boolean(slowSeconds && fastSeconds), `${fastSeconds} / ${slowSeconds}`);
  // Темп считаем по полной длительности (вместе с паузами): с разметкой он ниже.
  // Для этого текста: 3.99 слог/с с темпом против 4.5 без него. Артикуляция без пауз
  // (её мерил отдельный замер на Python) — 5.5 слог/с, это естественный диапазон.
  check('темп с разметкой медленнее прежнего', tempo > 3.6 && tempo < 4.3, String(tempo));
  check('без темпа речь была быстрее', Number(fastSeconds) < Number(slowSeconds), `${fastSeconds} / ${slowSeconds}`);
}

async function main() {
  loadEnv();
  testStructure();
  await testRealTempo();
  console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
