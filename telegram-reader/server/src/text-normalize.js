// Подготовка текста к озвучке: числа, проценты и денежные записи превращаются в слова.
//
// Зачем отдельный слой: Silero не произносит цифры, а Piper (espeak-ng) произносит их
// по-своему. Нормализация приводится к единому виду ДО синтеза, поэтому оба провайдера
// получают уже готовый к чтению текст.
//
// Что намеренно НЕ трогаем: URL, email, @упоминания, хэштеги, даты, время, версии ПО и
// длинные числовые идентификаторы. Их разбор требует контекста, а ошибка здесь хуже пропуска.
//
// Это первый этап: словарь числительных полный, но разбор контекста ограничен
// несколькими правилами (слово «год», предлоги вроде «в»/«с»/«до», название месяца).

const PLACEHOLDER_START = '\uE000';
const PLACEHOLDER_END = '\uE001';

const UNITS_M = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const UNITS_F = ['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
];

// Порядковые числительные: [именительный падеж, основа косвенных падежей].
// Косвенные образуются основой + ого/ому/ым/ом, кроме «третий» (третьего/третьему/третьим/третьем).
const ORDINALS = {
  1: ['первый', 'перв'],
  2: ['второй', 'втор'],
  3: ['третий', 'треть'],
  4: ['четвёртый', 'четвёрт'],
  5: ['пятый', 'пят'],
  6: ['шестой', 'шест'],
  7: ['седьмой', 'седьм'],
  8: ['восьмой', 'восьм'],
  9: ['девятый', 'девят'],
  10: ['десятый', 'десят'],
  11: ['одиннадцатый', 'одиннадцат'],
  12: ['двенадцатый', 'двенадцат'],
  13: ['тринадцатый', 'тринадцат'],
  14: ['четырнадцатый', 'четырнадцат'],
  15: ['пятнадцатый', 'пятнадцат'],
  16: ['шестнадцатый', 'шестнадцат'],
  17: ['семнадцатый', 'семнадцат'],
  18: ['восемнадцатый', 'восемнадцат'],
  19: ['девятнадцатый', 'девятнадцат'],
  20: ['двадцатый', 'двадцат'],
  30: ['тридцатый', 'тридцат'],
  40: ['сороковой', 'сороков'],
  50: ['пятидесятый', 'пятидесят'],
  60: ['шестидесятый', 'шестидесят'],
  70: ['семидесятый', 'семидесят'],
  80: ['восьмидесятый', 'восьмидесят'],
  90: ['девяностый', 'девяност'],
  100: ['сотый', 'сот'],
  200: ['двухсотый', 'двухсот'],
  300: ['трёхсотый', 'трёхсот'],
  400: ['четырёхсотый', 'четырёхсот'],
  500: ['пятисотый', 'пятисот'],
  600: ['шестисотый', 'шестисот'],
  700: ['семисотый', 'семисот'],
  800: ['восьмисотый', 'восьмисот'],
  900: ['девятисотый', 'девятисот'],
};

// Круглые тысячи читаются как одно слово: 2000 год → «двухтысячный год».
const THOUSAND_ORDINALS = {
  1000: ['тысячный', 'тысячн'],
  2000: ['двухтысячный', 'двухтысячн'],
  3000: ['трёхтысячный', 'трёхтысячн'],
  4000: ['четырёхтысячный', 'четырёхтысячн'],
  5000: ['пятитысячный', 'пятитысячн'],
  6000: ['шеститысячный', 'шеститысячн'],
  7000: ['семитысячный', 'семитысячн'],
  8000: ['восьмитысячный', 'восьмитысячн'],
  9000: ['девятитысячный', 'девятитысячн'],
};

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

// После этих слов четырёхзначное число — количество, а не год: «2000 человек».
const COUNT_NOUNS = [
  'человек',
  'человека',
  'рубл',
  'доллар',
  'евро',
  'процент',
  'километр',
  'метр',
  'тонн',
  'килограмм',
  'грамм',
  'мест',
  'штук',
  'единиц',
  'раз',
  'лет',
  'года',
  'году',
  'дней',
  'шагов',
  'голос',
  'балл',
];

const CURRENCIES = [
  { pattern: '₽|руб\\.?|рублей|рубля|рубль', forms: ['рубль', 'рубля', 'рублей'] },
  { pattern: '\\$|USD|долларов|доллара|доллар', forms: ['доллар', 'доллара', 'долларов'] },
  { pattern: '€|EUR|евро', forms: ['евро', 'евро', 'евро'] },
];

// Порядок важен: сначала то, что нельзя трогать, потом денежные и процентные записи.
const PROTECTED_PATTERNS = [
  /https?:\/\/[^\s]+/gi, // ссылки
  /www\.[^\s]+/gi,
  /[\w.+%-]+@[\w-]+\.[\w.-]+/gi, // email
  /[@#][\w_]{2,}/gi, // упоминания и хэштеги
  /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, // ISO-дата и время
  /\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, // дата вида 25.09.2026
  /\d{1,2}:\d{2}(?::\d{2})?/g, // время
  /\bv?\d+(?:\.\d+){2,}\b/gi, // версия из трёх и более частей
  /\bv\d+\.\d+\b/gi, // версия вида v2.5
  /\d{7,}/g, // длинные идентификаторы
  /\+?\d[\d\s()-]{7,}\d/g, // телефоны
];

function pluralForm(count, forms) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  const mod10 = count % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function threeDigitsToWords(value, feminine) {
  const units = feminine ? UNITS_F : UNITS_M;
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;

  if (hundreds > 0) words.push(HUNDREDS[hundreds]);

  if (rest >= 10 && rest <= 19) {
    words.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    if (tens > 0) words.push(TENS[tens]);
    const unit = rest % 10;
    if (unit > 0 || (words.length === 0 && value === 0)) words.push(units[unit]);
  }

  return words;
}

// Количественное числительное: 1500 → «тысяча пятьсот».
// feminine нужен для целой части дробей: 1.5 → «одна целая пять десятых».
export function intToWords(value, { feminine = false } = {}) {
  const n = Math.abs(Math.trunc(Number(value)));
  if (!Number.isFinite(n)) return [];
  if (n === 0) return ['ноль'];

  const groups = [
    { size: 1_000_000_000, forms: ['миллиард', 'миллиарда', 'миллиардов'], feminine: false },
    { size: 1_000_000, forms: ['миллион', 'миллиона', 'миллионов'], feminine: false },
    { size: 1_000, forms: ['тысяча', 'тысячи', 'тысяч'], feminine: true },
  ];

  const words = [];
  let rest = n;

  for (const group of groups) {
    const count = Math.floor(rest / group.size);
    rest %= group.size;
    if (count === 0) continue;

    // «тысяча пятьсот», а не «одна тысяча пятьсот» — так это читается по-русски.
    const omitUnit = group.size === 1_000 && count === 1;
    const groupWords = threeDigitsToWords(count, group.feminine);
    words.push(...(omitUnit ? groupWords.slice(1) : groupWords), pluralForm(count, group.forms));
  }

  if (rest > 0) words.push(...threeDigitsToWords(rest, feminine));
  return words;
}

function ordinalWord(key, grammaticalCase) {
  const entry = THOUSAND_ORDINALS[key] ?? ORDINALS[key];
  if (!entry) return null;
  if (grammaticalCase === 'nom') return entry[0];

  const endings = key === 3 ? { gen: 'его', dat: 'ему', ins: 'им', pre: 'ем' } : { gen: 'ого', dat: 'ому', ins: 'ым', pre: 'ом' };
  return entry[1] + endings[grammaticalCase];
}

// Порядковое числительное для числа до 999: 26 → «двадцать шестой».
function ordinalWords(value, grammaticalCase) {
  const direct = ordinalWord(value, grammaticalCase);
  if (direct) return [direct];

  if (value < 100) {
    const tens = Math.floor(value / 10) * 10;
    const unit = value % 10;
    const unitWord = ordinalWord(unit, grammaticalCase);
    if (unitWord) return [TENS[tens / 10], unitWord].filter(Boolean);
  }

  return intToWords(value);
}

// Год: 2026 → «две тысячи двадцать шестой», 1900 → «тысяча девятисотый».
export function yearToWords(value, grammaticalCase = 'nom') {
  const year = Math.abs(Math.trunc(Number(value)));
  if (THOUSAND_ORDINALS[year]) return [ordinalWord(year, grammaticalCase)];

  let lastKey = year;
  let prefixValue = 0;

  if (year % 100 !== 0) {
    lastKey = year % 100;
    prefixValue = year - lastKey;
  } else if (year % 1000 !== 0) {
    lastKey = year % 1000;
    prefixValue = year - lastKey;
  } else {
    lastKey = year;
  }

  const prefix = prefixValue > 0 ? intToWords(prefixValue) : [];
  return [...prefix, ...ordinalWords(lastKey, grammaticalCase)];
}

// Десятичная дробь: 3.14 → «три целых четырнадцать сотых».
export function decimalToWords(intPart, fracPart) {
  const digits = String(fracPart).length;
  const placeForms = { 1: ['десятая', 'десятых', 'десятых'], 2: ['сотая', 'сотых', 'сотых'], 3: ['тысячная', 'тысячных', 'тысячных'] };
  const place = placeForms[Math.min(digits, 3)] ?? placeForms[3];

  const whole = Math.trunc(Number(intPart));
  const wholeWords = Number.isFinite(whole) ? intToWords(whole, { feminine: true }) : [];
  const wholeTail = pluralForm(whole, ['целая', 'целых', 'целых']);
  const fraction = Number(fracPart);
  const fractionWords = intToWords(fraction);
  const fractionTail = fraction === 1 ? place[0] : place[1];

  return [...wholeWords, wholeTail, ...fractionWords, fractionTail];
}

function replaceProtected(text) {
  const saved = [];
  let result = text;

  for (const pattern of PROTECTED_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Внутри метки не должно быть цифр, иначе её подхватит правило обычных чисел.
      const index = saved.push(match) - 1;
      let encoded = '';
      let rest = index;
      do {
        encoded = String.fromCharCode(97 + (rest % 26)) + encoded;
        rest = Math.floor(rest / 26) - 1;
      } while (rest >= 0);
      return `${PLACEHOLDER_START}${encoded}${PLACEHOLDER_END}`;
    });
  }

  return { text: result, saved };
}

function restoreProtected(text, saved) {
  return text.replace(new RegExp(`${PLACEHOLDER_START}([a-z]+)${PLACEHOLDER_END}`, 'g'), (_match, encoded) => {
    let index = 0;
    for (const char of encoded) index = index * 26 + (char.charCodeAt(0) - 97 + 1);
    return saved[index - 1] ?? _match;
  });
}

const YEAR_CASES_BY_WORD = {
  год: 'nom',
  года: 'gen',
  году: 'pre',
  годом: 'ins',
  годе: 'pre',
  годы: 'nom',
  годов: 'gen',
  годам: 'dat',
  годами: 'ins',
  годах: 'pre',
  'г.': 'nom',
};

const YEAR_CASES_BY_PREPOSITION = { в: 'pre', во: 'pre', с: 'gen', со: 'gen', до: 'gen', от: 'gen', к: 'dat', ко: 'dat', о: 'pre', об: 'pre' };

function isYearLike(value) {
  return value >= 1900 && value <= 2199;
}

function countNumberGuard(nextWord) {
  const word = nextWord.toLowerCase();
  return COUNT_NOUNS.some((noun) => word.startsWith(noun));
}

function wordsToText(words) {
  return words.join(' ');
}

function normalizeNumbers(text) {
  // Деньги: «1000 ₽», «$20», «20 долларов».
  // Захватываем только цифры и разделители внутри числа («1 000»), но не пробел после него,
  // иначе вместе с числом съедается пробел перед следующим словом.
  const number = '(\\d+(?:[ \\u00A0]\\d+)*)';

  for (const currency of CURRENCIES) {
    const after = new RegExp(`${number}\\s*(?:${currency.pattern})`, 'gi');
    text = text.replace(after, (_m, digits) => `${wordsToText(intToWords(digits.replace(/[^\d]/g, '')))} ${pluralForm(Number(digits.replace(/[^\d]/g, '')), currency.forms)}`);

    const before = new RegExp(`(?:${currency.pattern})\\s*${number}`, 'gi');
    text = text.replace(before, (_m, digits) => `${wordsToText(intToWords(digits.replace(/[^\d]/g, '')))} ${pluralForm(Number(digits.replace(/[^\d]/g, '')), currency.forms)}`);
  }

  // Проценты: 15% → «пятнадцать процентов».
  text = text.replace(/(\d+)\s*%/g, (_m, digits) => `${wordsToText(intToWords(digits))} ${pluralForm(Number(digits), ['процент', 'процента', 'процентов'])}`);

  // Дата со словом-месяцем: «12 мая» → «двенадцатого мая».
  // Границы слова заданы lookaround, а не \b: в JavaScript \b не работает с кириллицей.
  const months = MONTHS_GENITIVE.join('|');
  text = text.replace(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${months})(?![а-яё])`, 'gi'), (_m, day, month) => `${wordsToText(ordinalWords(Number(day), 'gen'))} ${month.toLowerCase()}`);

  // Год со словом «год» и в падеже этого слова: «в 2026 году» → «в две тысячи двадцать шестом году».
  const yearWords = Object.keys(YEAR_CASES_BY_WORD).map((w) => w.replace('.', '\\.')).join('|');
  text = text.replace(
    new RegExp(`\\b(\\d{4})\\s+(${yearWords})(?![а-яё])`, 'gi'),
    (_m, year, word) => `${wordsToText(yearToWords(Number(year), YEAR_CASES_BY_WORD[word.toLowerCase()]))} ${word}`,
  );

  // Одиночный год: «в 2026» → предложный падеж, «2026» → именительный.
  text = text.replace(/(^|[\s(«"])(\d{4})(?=[\s).,;:!?»"]|$)/g, (match, before, digits, offset, whole) => {
    const value = Number(digits);
    const nextWord = (whole.slice(offset + match.length).match(/^[\s]*([А-Яа-яЁёA-Za-z]+)/) ?? [])[1] ?? '';
    if (!isYearLike(value) || countNumberGuard(nextWord)) return match;

    const previousWord = (whole.slice(0, offset).match(/([А-Яа-яЁёA-Za-z]+)\s*$/) ?? [])[1] ?? '';
    const grammaticalCase = YEAR_CASES_BY_PREPOSITION[previousWord.toLowerCase()] ?? 'nom';
    return `${before}${wordsToText(yearToWords(value, grammaticalCase))}`;
  });

  // Десятичные дроби: 3.14 → «три целых четырнадцать сотых».
  text = text.replace(/\b(\d+)[.,](\d{1,3})\b/g, (_m, intPart, fracPart) =>
    wordsToText(decimalToWords(intPart, fracPart.replace(/0+$/, '') || '0')),
  );

  // Остальные целые числа.
  text = text.replace(/\b\d+\b/g, (digits) => wordsToText(intToWords(digits)));

  return text;
}

// Замена строчной буквы на заглавную в начале предложения: после нормализации
// предложение может начинаться с числа, которое стало словом («12 мая» → «двенадцатого мая»).
// Первую букву всего текста не трогаем — это правка автора, а не наша задача.
function capitalizeSentences(text) {
  return text.replace(/([.!?…]\s+)([а-яё])/g, (match, prefix, char, offset, whole) => {
    const before = whole.slice(0, offset + prefix.length - 1);
    // Сокращения вида «т. е.», «и т. д.» не трогаем.
    if (/(^|\s)[а-яё]\.$/.test(before)) return match;
    return prefix + char.toUpperCase();
  });
}

// Главная точка входа: текст поста → текст, готовый к озвучке.
export function normalizeText(text) {
  const source = String(text ?? '');
  if (!source.trim()) return '';

  const startsWithDigit = /^\s*\d/.test(source);
  const { text: withoutProtected, saved } = replaceProtected(source);
  const normalized = normalizeNumbers(withoutProtected);
  const restored = restoreProtected(normalized, saved)
    // Переводы строк сохраняем: по ним слой просодии видит абзацы и списки.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const capitalized = capitalizeSentences(restored);

  // Если текст начинался с числа, оно стало словом — тогда первая буква заглавная.
  return startsWithDigit ? capitalized.replace(/^([а-яё])/, (m) => m.toUpperCase()) : capitalized;
}

// Для отладки: что было и что уйдёт в синтез.
export function describeNormalization(text) {
  return { original: String(text ?? ''), normalized: normalizeText(text) };
}
