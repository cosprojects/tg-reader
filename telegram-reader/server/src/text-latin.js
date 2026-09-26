// Нормализация латиницы и смешанного русского/английского текста перед просодией.
//
// Зачем отдельный слой. Замеры текущего pipeline (silero v5_5_ru, голос aidar) показали
// два отказа, а не один:
//   • латиница внутри русского текста молча пропадает — «Мы добавили AI в новый продукт.»
//     звучит ровно столько же, сколько «Мы добавили в новый продукт.» (2.062 с в обоих случаях),
//     то же с API: 1.8 с против 1.8 с без него;
//   • фрагмент, целиком состоящий из латиницы, роняет синтез: silero_tts_cli.py падает
//     с ValueError в process_simple_text и не пишет файл (28 проб из 74 в замере).
// Поэтому «оставить латиницу как есть» нельзя: она либо исчезает из озвучки, либо
// обрывает её. Замена нужна ещё и ради пауз: любая латинская буква заставляет
// chunkToProviderText читать часть без SSML, то есть без просодии.
//
// Тип конструкции важнее общего правила, поэтому порядок разбора такой:
//   1. URL и email — отдельные правила (посимвольное чтение адресов недопустимо);
//   2. упоминания и хэштеги;
//   3. технические конструкции: версии, составные токены вида CI/CD;
//   4. смешанные слова: латиница, склеенная дефисом с русским словом;
//   5. словарь терминов и аббревиатур (основной механизм);
//   6. резерв для незнакомых слов — посимвольно для нечитаемых сокращений,
//      транслитерация для остальных. Резерв грубый намеренно: словарь пополняется
//      по мере появления новых слов в постах, а не заранее.
//
// Что сюда сознательно не входит: ударения (отдельный этап) и разбор чисел, годов,
// процентов, дат и времени — этим занимается text-normalize.js, и его поведение
// не меняется. Слой работает поверх результата числовой нормализации.

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
// Голый домен без схемы (docs.example.com, t.me/reader) числовой слой не защищает,
// а синтез превратил бы его в одно длинное «слово». Список зон ограничен, чтобы под
// правило не попадали «Node.js» и подобные технические имена. Адрес внутри email
// исключён: его разбирает отдельное правило ниже.
const BARE_DOMAIN_PATTERN =
  /(?<!@)\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:ru|com|org|net|io|dev|ai|app|me|tv|co|info|edu|gov|tech|store|online|site|xyz|pro|cloud|blog|news)\b(?:\/[^\s<>()]*)?/gi;
// Точка и запятая после адреса принадлежат предложению, а не адресу: без этого
// «https://example.com.» терял бы точку, а вместе с ней и паузу в просодии.
const TRAILING_PUNCTUATION = /[.,;:!?»)]+$/;
const EMAIL_PATTERN = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)*/gi;
const MENTION_PATTERN = /@[A-Za-z][A-Za-z0-9_]{1,}/g;
const HASHTAG_PATTERN = /#[A-Za-z][A-Za-z0-9_]{1,}/g;
// Токен: латиница с цифрами, точками и подчёркиваниями. Нужен, чтобы «Node.js»,
// «B2B» и «a3f9b2c1» разбирались целиком, а не распадались на куски. Точка внутри
// токена допустима только между значимыми частями: иначе «API.» съедал бы точку
// и склеивал предложения, ломая паузы просодии.
const LATIN_TOKEN = /[A-Za-z0-9_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g;
// Версия из нескольких частей: numeric-слой такие строки намеренно не трогает,
// поэтому сюда они приходят как есть и без чтения остались бы беззвучными.
const DOTTED_NUMBER = /\b\d+(?:\.\d+){2,}\b/g;
// Дата вида 25.09.2026 — это не версия: её разбор остаётся за числовым слоем,
// и превращать её в «два пять точка ноль девять» нельзя.
const DATE_LIKE = /^\d{1,2}\.\d{1,2}\.\d{4}$/;
const V_VERSION = /\bv(\d+(?:\.\d+)+)\b/gi;

const URL_WORD = 'ссылка';
const EMAIL_WORD = 'электронная почта';
const MENTION_WORD = 'упоминание';
const HASHTAG_WORD = 'хэштег';

// Аббревиатуры, которые читаются не по общему правилу: либо как слово, либо
// с гласной внутри, из-за которой буквенное чтение не выводится автоматически.
const SPECIAL_ABBREVIATIONS = new Map([
  ['ai', 'эй-ай'],
  ['api', 'эй-пи-ай'],
  ['ui', 'ю-ай'],
  ['ux', 'ю-икс'],
  ['gpt', 'джи-пи-ти'],
  ['mvp', 'эм-ви-пи'],
  ['url', 'ю-ар-эл'],
  ['uri', 'ю-ар-ай'],
  ['seo', 'эс-и-о'],
  ['crm', 'си-ар-эм'],
  ['kpi', 'кей-пи-ай'],
  ['faq', 'эф-эй-кью'],
  ['ceo', 'си-и-о'],
  ['cto', 'си-ти-о'],
  ['ci', 'си-ай'],
  ['cd', 'си-ди'],
  ['id', 'ай-ди'],
  ['ip', 'ай-пи'],
  ['it', 'ай-ти'],
  ['os', 'ос'],
  ['qa', 'кью-эй'],
  ['pm', 'пи-эм'],
  ['po', 'пи-оу'],
  ['js', 'джей-эс'],
  ['ts', 'ти-эс'],
  ['sql', 'эс-кью-эл'],
  ['json', 'джейсон'],
  ['yaml', 'ямл'],
  ['ml', 'эм-эл'],
  ['llm', 'эл-эл-эм'],
  ['gpu', 'джи-пи-ю'],
  ['cpu', 'си-пи-ю'],
  ['ide', 'ай-ди-и'],
  ['http', 'эйч-ти-ти-пи'],
  ['https', 'эйч-ти-ти-пи-эс'],
  ['pdf', 'пи-ди-эф'],
  ['sms', 'эс-эм-эс'],
  ['p2p', 'пи-ту-пи'],
  ['rag', 'раг'],
  ['saas', 'саас'],
  ['b2b', 'би-ту-би'],
  ['b2c', 'би-ту-си'],
  ['b2g', 'би-ту-джи'],
]);

// Термины и бренды: как их произносит русская речь. Словарь намеренно короткий —
// только то, что реально встречается в постах Telegram Reader и проверено синтезом
// (server/test-latin.mjs и замеры в отчёте).
const TERMS = new Map([
  ['openai', 'опен эй ай'],
  ['chatgpt', 'чат джи-пи-ти'],
  ['iphone', 'айфон'],
  ['ipad', 'айпад'],
  ['apple', 'эпл'],
  ['macos', 'макос'],
  ['windows', 'виндоус'],
  ['linux', 'линукс'],
  ['android', 'андроид'],
  ['telegram', 'телеграм'],
  ['figma', 'фигма'],
  ['cursor', 'курсор'],
  ['react', 'реакт'],
  ['node.js', 'ноуд джей эс'],
  ['nodejs', 'ноуд джей эс'],
  ['next.js', 'некст джей эс'],
  ['nextjs', 'некст джей эс'],
  ['vue.js', 'вью джей эс'],
  ['vuejs', 'вью джей эс'],
  ['typescript', 'тайпскрипт'],
  ['javascript', 'джаваскрипт'],
  ['python', 'питон'],
  ['postgresql', 'постгрес'],
  ['postgres', 'постгрес'],
  ['github', 'гитхаб'],
  ['gitlab', 'гитлаб'],
  ['docker', 'докер'],
  ['kubernetes', 'кубернетес'],
  ['notion', 'ноушен'],
  ['slack', 'слак'],
  ['zoom', 'зум'],
  ['figjam', 'фигджем'],
  ['email', 'электронная почта'],
  ['e-mail', 'электронная почта'],
]);

// Имена латинских букв по-русски — для посимвольного чтения сокращений.
const LETTER_NAMES = {
  a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч',
  i: 'ай', j: 'джей', k: 'кей', l: 'эл', m: 'эм', n: 'эн', o: 'оу', p: 'пи',
  q: 'кью', r: 'ар', s: 'эс', t: 'ти', u: 'ю', v: 'вэ', w: 'дабл-ю', x: 'икс',
  y: 'уай', z: 'зет',
};

const DIGIT_NAMES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];

// Практическая транслитерация незнакомых слов: сначала диграфы, затем буквы.
// Точность здесь не самоцель — важно, чтобы слово прозвучало, а не пропало;
// часто встречающиеся слова попадают в TERMS и читаются точно.
const DIGRAPHS = [
  ['iew', 'ью'], ['sh', 'ш'], ['ch', 'ч'], ['th', 'т'], ['ph', 'ф'], ['ck', 'к'], ['qu', 'кв'],
  ['oo', 'у'], ['ee', 'и'], ['ea', 'и'], ['ou', 'оу'], ['ow', 'оу'], ['ew', 'ью'],
  ['oi', 'ой'], ['oy', 'ой'], ['ay', 'ей'], ['ai', 'ей'], ['ey', 'ей'], ['ie', 'и'],
  ['gh', 'г'], ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'], ['ye', 'е'], ['zh', 'ж'], ['kh', 'х'],
];

const SINGLE_LETTERS = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и',
  j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р',
  s: 'с', t: 'т', u: 'у', v: 'в', w: 'у', x: 'кс', y: 'й', z: 'з',
};

// Английская «немая e» и долгий гласный перед ней: Node → ноуд, Vite → вайт, SALE → сейл.
const LONG_VOWELS = { a: 'ей', e: 'и', i: 'ай', o: 'оу', u: 'ю' };
// Сочетания с r на конце читаются иначе: store → стор, wire → вайр. Их обрабатываем
// до правила немой e, иначе «store» получалось бы «стоур».
const R_ENDINGS = [
  ['ore', 'ор'], ['are', 'эр'], ['ere', 'эр'], ['ire', 'айр'], ['ure', 'юр'], ['yre', 'айр'],
];
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

function hasVowel(word) {
  return [...word].some((char) => VOWELS.has(char));
}

// Посимвольное чтение: API → «эй-пи-ай», a3f9 → «эй-три-эф-девять».
function readByLetters(token) {
  const parts = [];
  for (const char of token) {
    const lower = char.toLowerCase();
    if (LETTER_NAMES[lower]) parts.push(LETTER_NAMES[lower]);
    else if (/\d/.test(char)) parts.push(DIGIT_NAMES[Number(char)]);
  }
  return parts.join('-');
}

// Версия: 2.5 → «два точка пять», 1.2.3 → «один точка два точка три».
function readVersion(digits) {
  return digits
    .split('.')
    .map((part) => [...part].map((char) => DIGIT_NAMES[Number(char)]).join(' '))
    .join(' точка ');
}

// Незнакомое слово: английская орфография → русские буквы.
function transliterate(word) {
  const lower = word.toLowerCase();

  // w в начале слова перед гласной читается как «в»: Webpack → вебпак, Windows → виндоус.
  // Правило применяется к латинской строке, пока следующие буквы ещё латинские.
  let prepared = lower.replace(/^w(?=[aeiouy])/, 'в');

  // Сочетания с r на конце: store → стор, wire → вайр. Немая e здесь уже учтена.
  const rEnding = R_ENDINGS.find(([ending]) => prepared.endsWith(ending));
  if (rEnding) {
    prepared = `${prepared.slice(0, -rEnding[0].length)}${rEnding[1]}`;
  } else if (prepared.length > 2 && prepared.endsWith('e') && !VOWELS.has(prepared[prepared.length - 2])) {
    // Немая e на конце меняет чтение предыдущего гласного: Node → ноуд, Vite → вайт.
    const stem = prepared.slice(0, -1);
    const vowelIndex = stem.length - 2;
    const longVowel = LONG_VOWELS[stem[vowelIndex]];
    prepared = longVowel ? `${stem.slice(0, vowelIndex)}${longVowel}${stem.slice(vowelIndex + 1)}` : stem;
  }

  // Диграфы заменяются на кириллицу, поэтому дальше по строке идут уже русские буквы:
  // их нужно сохранять как есть, а не терять (иначе «Webpack» превращался в «уебпа»).
  for (const [digraph, replacement] of DIGRAPHS) prepared = prepared.split(digraph).join(replacement);

  let result = '';
  for (const char of prepared) {
    if (/[а-яё]/.test(char)) result += char;
    else if (SINGLE_LETTERS[char]) result += SINGLE_LETTERS[char];
    else if (/\d/.test(char)) result += DIGIT_NAMES[Number(char)];
  }

  return result.replace(/([а-яё])\1+/g, '$1');
}

// Решение по одному латинскому токену. Порядок: словари → тип токена → резерв.
function readToken(token) {
  const lower = token.toLowerCase();
  if (SPECIAL_ABBREVIATIONS.has(lower)) return SPECIAL_ABBREVIATIONS.get(lower);
  if (TERMS.has(lower)) return TERMS.get(lower);

  const letters = token.replace(/[^A-Za-z]/g, '');
  const hasDigits = /\d/.test(token);
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();

  // Цифры вместе с буквами (a3f9b2c1, utf8) — идентификатор, читаем посимвольно.
  if (hasDigits) return readByLetters(token);

  // Заглавные без гласных (GPT, SQL, CRM) читаются по буквам: словом их не произнести.
  if (isAllCaps && !hasVowel(lower)) return readByLetters(token);

  // Заглавные с гласными не считаем аббревиатурой автоматически: SALE читается
  // как слово, а не «эс-эй-эл-и». Сокращения с гласными (KPI, IDE) берёт словарь выше.
  return transliterate(letters);
}

// URL и email: адреса не читаются посимвольно, поэтому заменяются словами.
// Оригинальный текст поста при этом не меняется: слой работает только над тем,
// что уходит в синтез.
function replaceAddresses(text) {
  // Порядок важен: email разбирается до голого домена, иначе от «hello@example.com»
  // осталось бы «hello@ссылка».
  const keepPunctuation = (match) => {
    if (!/[A-Za-z]/.test(match)) return match;
    const trimmed = match.replace(TRAILING_PUNCTUATION, '');
    return URL_WORD + match.slice(trimmed.length);
  };

  let result = text
    .replace(URL_PATTERN, keepPunctuation)
    .replace(EMAIL_PATTERN, EMAIL_WORD)
    .replace(BARE_DOMAIN_PATTERN, keepPunctuation);

  // «Подробнее: https://…» → «Подробнее. Ссылка.» — после слова «ссылка» нужна
  // отдельная фраза, иначе двоеточие тянет её в предыдущее предложение.
  const capital = (word) => `${word[0].toUpperCase()}${word.slice(1)}`;
  result = result.replace(new RegExp(`:\\s*${URL_WORD}`, 'g'), `. ${capital(URL_WORD)}`);
  result = result.replace(new RegExp(`:\\s*${EMAIL_WORD}`, 'g'), `. ${capital(EMAIL_WORD)}`);

  // Согласование предлогов: «напишите на hello@example.com» → «напишите на электронную почту»,
  // «подробнее на https://…» → «подробнее на ссылку». Границы слова заданы без \b:
  // в JavaScript \b не работает с кириллицей.
  result = result.replace(new RegExp(`(на\\s+)${EMAIL_WORD}`, 'gi'), '$1электронную почту');
  result = result.replace(new RegExp(`(по\\s+)${EMAIL_WORD}`, 'gi'), '$1электронной почте');
  result = result.replace(new RegExp(`(на\\s+)${URL_WORD}`, 'gi'), '$1ссылку');
  result = result.replace(new RegExp(`(по\\s+)${URL_WORD}`, 'gi'), '$1ссылке');

  // Замена в начале фразы — с заглавной буквы.
  return result.replace(new RegExp(`(^|[.!?…]\\s+)(${URL_WORD}|${EMAIL_WORD})`, 'g'), (_m, prefix, word) => `${prefix}${capital(word)}`);
}

// Главная точка входа: текст после числовой нормализации → текст без латиницы.
export function normalizeLatin(text) {
  const source = String(text ?? '');
  if (!/[A-Za-z]/.test(source)) return source;

  let result = replaceAddresses(source);

  result = result.replace(MENTION_PATTERN, MENTION_WORD);
  result = result.replace(HASHTAG_PATTERN, HASHTAG_WORD);

  // Версии: numeric-слой оставляет их нетронутыми, а без чтения они беззвучны.
  result = result.replace(DOTTED_NUMBER, (match) => (DATE_LIKE.test(match) ? match : readVersion(match)));
  result = result.replace(V_VERSION, (_match, digits) => `вэ ${readVersion(digits)}`);

  // CI/CD и подобные пары: «си-ай и си-ди».
  result = result.replace(/\b([A-Za-z]{2,})\/([A-Za-z]{2,})\b/g, (_m, left, right) => `${readToken(left)} и ${readToken(right)}`);

  // Смешанные слова: латиница, склеенная дефисом с русским словом. Дефис заменяется
  // пробелом: «эй-ай сервис» читается как два слова, а не как одно длинное.
  result = result.replace(/([A-Za-z0-9_][A-Za-z0-9._]*)-([А-Яа-яЁё])/g, (_m, latin, next) => `${readToken(latin)} ${next}`);
  result = result.replace(/([А-Яа-яЁё])-([A-Za-z0-9_][A-Za-z0-9._]*)/g, (_m, prev, latin) => `${prev} ${readToken(latin)}`);

  // Остальные латинские токены — через словарь и типизированные правила.
  result = result.replace(LATIN_TOKEN, (match) => (/[A-Za-z]/.test(match) ? readToken(match) : match));

  // Страховка: латиницы в тексте для синтеза остаться не должно — иначе часть уйдёт
  // в Silero без SSML (без пауз), и слово пропадёт из озвучки.
  result = result.replace(/[A-Za-z]+/g, (match) => readByLetters(match));

  return result
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+([,.;:!?])/g, '$1')
    .trim();
}

// Для отладки: словари и результат последнего шага.
export function describeLatinNormalization(text) {
  const source = String(text ?? '');
  const normalized = normalizeLatin(source);
  return {
    source,
    normalized,
    changed: normalized !== source,
    latinLeft: (normalized.match(/[A-Za-z]/g) ?? []).length,
    abbreviations: Object.fromEntries(SPECIAL_ABBREVIATIONS),
    terms: Object.fromEntries(TERMS),
  };
}

export const LATIN_DICTIONARY = { abbreviations: SPECIAL_ABBREVIATIONS, terms: TERMS };
