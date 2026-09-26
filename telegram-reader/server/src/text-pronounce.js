// Слой произношения: ударения в словах, где модель ошибается.
//
// Механизм (проверен на самой модели, а не выбран наугад). У v5_5_ru знак «+» перед
// гласной входит в набор символов модели:
//   '_~|!+,-.:;?абвгдежзийклмнопрстуфхцчшщъыьэюяё–… '
// то есть это штатный знак ударения. Внутри пакета есть акцентор
// (AccentorNgramClean, stress_token='+'), который расставляет ударения по n-граммной
// модели, но слово с уже поставленным «+» не переакцентирует — ручная разметка
// побеждает. Проверка: вариант с «+» на той же гласной, что выбрала модель, даёт
// побайтово тот же звук; «+» на другой гласной — заметно другой звук.
//
// Что слой делает и чего не делает: размечены только слова из словаря. Расставлять
// ударения по всем словам подряд нельзя — модель уже верно произносит большинство
// слов, и массовая разметка ухудшит именно то, что сейчас звучит правильно.
//
// Словарь — отдельный JSON рядом с кодом сервера, чтобы его можно было пополнять
// по фактическим ошибкам, не трогая код:
//   server/pronunciation_rules.json
// Ключ — слово в нижнем регистре; «*» в конце ключа разрешает любую форму
// («обеспечение*» поймает и «обеспечением»). Значение — та же словоформа со знаком
// «+» перед ударной гласной. Путь можно переопределить переменной окружения
// PRONUNCIATION_RULES (нужно тестам и экспериментам).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_FILE = path.resolve(here, '..', 'pronunciation_rules.json');

// Границы слова задаются lookaround, а не \b: в JavaScript \b не работает с кириллицей.
// «+» входит в набор границ, иначе уже размеченное слово («догов+ор») поймалось бы
// повторно правилом для «догов».
const LETTER = '[А-Яа-яЁё]';
const BOUNDARY_CHARS = '[А-Яа-яЁё+]';
const WORD_KEY = /^[а-яё-]+$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Правило из JSON → внутренняя форма. plusAt — индекс знака «+» в словоформе без «*».
function compileRule(key, value) {
  const wildcard = key.endsWith('*');
  const word = wildcard ? key.slice(0, -1) : key;
  const marked = String(value ?? '');
  const plain = marked.replace(/\+/g, '');
  const plusCount = (marked.match(/\+/g) ?? []).length;

  if (!WORD_KEY.test(word) || word.length < 2) {
    return { problem: `ключ «${key}»: слово должно состоять из русских букв и дефиса` };
  }
  if (plusCount !== 1) {
    return { problem: `правило «${key}»: в значении нужен ровно один знак «+» (сейчас ${plusCount})` };
  }
  if (plain.toLowerCase() !== word) {
    return { problem: `правило «${key}»: значение «${marked}» без «+» даёт «${plain}», а не «${word}»` };
  }

  return {
    key,
    word,
    wildcard,
    plusAt: marked.indexOf('+'),
    pattern: wildcard
      ? new RegExp(`(?<!${BOUNDARY_CHARS})${escapeRegExp(word)}(${LETTER}*)(?!${BOUNDARY_CHARS})`, 'gi')
      : new RegExp(`(?<!${BOUNDARY_CHARS})${escapeRegExp(word)}(?!${BOUNDARY_CHARS})`, 'gi'),
    changes: 0,
  };
}

// Словарь: файл читается один раз при загрузке модуля. Битый или отсутствующий файл
// не должен ломать синтез — тогда слой просто ничего не меняет.
export function loadPronunciationRules(file = process.env.PRONUNCIATION_RULES || DEFAULT_RULES_FILE) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { rules: [], problems: [`словарь не прочитан (${file}): ${error.message}`], file };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rules: [], problems: [`словарь должен быть объектом «слово»: «форма с +» (${file})`], file };
  }

  const rules = [];
  const problems = [];
  const seen = new Set();

  for (const [key, value] of Object.entries(raw)) {
    // Ключи, начинающиеся с «_», — комментарии в JSON, они не правила.
    if (key.startsWith('_')) continue;

    const rule = compileRule(key.toLowerCase(), value);
    if (rule.problem) {
      problems.push(rule.problem);
      continue;
    }
    if (seen.has(rule.word)) {
      problems.push(`правило «${key}»: слово «${rule.word}» уже описано выше`);
      continue;
    }
    seen.add(rule.word);
    rules.push(rule);
  }

  return { rules, problems, file };
}

// Регистр исходного слова переносится на размеченную форму: «Договор» → «Догов+ор»,
// «ДОГОВОР» → «ДОГОВ+ОР».
function matchCase(marked, source) {
  const letters = source.replace(/[^А-Яа-яЁё]/g, '');
  if (letters && letters === letters.toUpperCase()) return marked.toUpperCase();
  if (source[0] === source[0]?.toUpperCase() && source[0] !== source[0]?.toLowerCase()) {
    return marked[0].toUpperCase() + marked.slice(1);
  }
  return marked;
}

// Главная точка входа: текст для синтеза → текст с расставленными ударениями.
// Возвращает изменения, чтобы их можно было показать в debug-логе.
export function applyPronunciation(text, { rules = [] } = {}) {
  let result = String(text ?? '');
  const changes = [];

  for (const rule of rules) {
    // У правил с «*» первым аргументом приходит окончание, у точных правил — смещение
    // совпадения, поэтому окончание берём только у правил со «*».
    result = result.replace(rule.pattern, (match, ...rest) => {
      const ending = rule.wildcard ? String(rest[0] ?? '') : '';
      const plain = rule.word + ending;
      const marked = `${plain.slice(0, rule.plusAt)}+${plain.slice(rule.plusAt)}`;
      changes.push({ word: match, marked: matchCase(marked, match) });
      return matchCase(marked, match);
    });
  }

  return { text: result, changes };
}

// Для логов: только те слова, которые слой действительно изменил.
export function describePronunciation(text, { rules = [] } = {}) {
  return applyPronunciation(text, { rules }).changes;
}

// Сам словарь — для отчёта и тестов.
export function pronunciationDictionary() {
  const { rules, problems, file } = loadPronunciationRules();
  return {
    file,
    problems,
    entries: rules.map((rule) => ({
      key: rule.key,
      marked: `${rule.word.slice(0, rule.plusAt)}+${rule.word.slice(rule.plusAt)}`,
      wildcard: rule.wildcard,
    })),
  };
}
