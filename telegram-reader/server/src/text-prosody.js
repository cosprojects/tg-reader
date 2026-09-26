// Просодическая разметка: паузы и структура текста для Silero.
//
// Механизм взят из документации модели (SSML для v5) и проверен замерами на нашем голосе:
//   <break time="400ms"/> → пауза ≈360 мс, <break time="700ms"/> → ≈690 мс,
//   <p> → ≈1000 мс, <s> → почти ничего сверх обычной точки,
//   а знаки препинания Silero расставляет сам: точка ≈190 мс, запятая ≈140 мс, тире ≈170 мс.
//
// Поэтому слой добавляет только то, чего модель не видит сама: границы абзацев,
// заголовки, пункты списков и разбиение слишком длинных предложений.
// Запятые, точки, двоеточия и тире намеренно не трогаем — иначе пауз станет вдвое больше.

const XML_ESCAPES = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
];

// Значения подобраны по замерам пауз: см. комментарий выше.
export const PAUSE_MS = {
  paragraph: 700,
  headingBefore: 300,
  headingAfter: 600,
  listItem: 400,
  longSentence: 250,
};

// Темп чтения. Модель без разметки читает со скоростью ≈6.2 слога в секунду — для
// русской речи это быстро, слова сливаются и слышится спешка. Естественный темп
// разговорной речи 5.0–5.5 слога/с. Замеры на нашем голосе (aidar):
//   без разметки 6.23 слога/с, rate="90%" → 5.85, rate="88%" → 5.51,
//   rate="slow" (0.8) → 5.15, rate="x-slow" (0.5) → 3.31 (слишком медленно).
// Берём 88%: это ровно верхняя граница естественного темпа. Значение принимается
// моделью в теге <prosody>; проценты она разбирает сама (проверено).
export const SPEECH_RATE = '88%';

function rateTag(content) {
  return `<prosody rate="${SPEECH_RATE}">${content}</prosody>`;
}

// Предложение длиннее этого считаем слишком длинным для чтения на одном дыхании.
// 160 символов — это примерно 10 секунд речи без паузы.
const LONG_SENTENCE_CHARS = 160;
// Совсем длинное предложение допускает две паузы вместо одной.
const VERY_LONG_SENTENCE_CHARS = 380;

const LIST_MARKER = /^\s*(?:[-–—•*]|\d{1,2}[.)])\s+/;
const SENTENCE_SPLIT = /[^.!?…]+[.!?…]+[\s]*|[^.!?…]+$/g;
// Слова, после которых уместно сделать вдох внутри длинной фразы.
const CLAUSE_CONJUNCTIONS = [' и ', ' а ', ' но ', ' однако ', ' по словам ', ' потому что ', ' который ', ' которые ', ' что '];

function escapeXml(text) {
  return XML_ESCAPES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function breakTag(ms) {
  return `<break time="${ms}ms"/>`;
}

// Заголовок: короткая строка капсом либо короткая строка без завершающей точки.
// Строка с точкой внутри — это обычная проза («Пост в трех частях. Часть 1»).
function isHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return false;

  const letters = trimmed.replace(/[^А-Яа-яЁёA-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return true;

  return !/[.!?…]$/.test(trimmed) && !/[.!?…]\s/.test(trimmed);
}

// Ищет в длинном предложении места для вдоха: после запятой, иначе перед союзом.
// Возвращает позиции в исходной строке; слова не меняются и не сокращаются.
function breathPositions(sentence) {
  const limit = sentence.length > VERY_LONG_SENTENCE_CHARS ? 2 : 1;
  const positions = [];
  let cursor = 0;

  for (let step = 0; step < limit; step += 1) {
    const rest = sentence.slice(cursor);
    if (rest.length <= LONG_SENTENCE_CHARS) break;

    const min = Math.floor(rest.length * 0.35);
    const max = Math.floor(rest.length * 0.7);
    let position = -1;

    for (let i = min; i < max; i += 1) {
      if (rest[i] === ',' && rest[i + 1] === ' ') position = i + 1;
    }
    if (position === -1) {
      for (const conjunction of CLAUSE_CONJUNCTIONS) {
        const found = rest.indexOf(conjunction, min);
        if (found !== -1 && found < max) {
          position = found + 1;
          break;
        }
      }
    }
    if (position === -1) break;

    positions.push(cursor + position);
    cursor += position;
  }

  return positions;
}

// Предложение → SSML-фрагмент: части экранируются по отдельности,
// между ними остаётся тег паузы (иначе экранирование съело бы сам тег).
function sentenceToSsml(sentence) {
  const positions = sentence.length > LONG_SENTENCE_CHARS ? breathPositions(sentence) : [];
  if (positions.length === 0) return escapeXml(sentence);

  const pieces = [];
  let start = 0;
  for (const position of positions) {
    pieces.push(escapeXml(sentence.slice(start, position).trim()));
    start = position;
  }
  pieces.push(escapeXml(sentence.slice(start).trim()));

  return pieces.filter(Boolean).join(breakTag(PAUSE_MS.longSentence));
}

function sentenceTags(block) {
  const sentences = block.match(SENTENCE_SPLIT) ?? [block];
  return sentences.map((sentence) => sentenceToSsml(sentence.trim())).filter(Boolean).join(' ');
}

function listTags(lines) {
  return lines
    .map((line) => escapeXml(line.trim()))
    .filter(Boolean)
    .join(breakTag(PAUSE_MS.listItem));
}

// Абзацы по пустым строкам; одиночные переводы внутри абзаца — это строки списка.
function toParagraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);
}

// Строки одного абзаца: после строки-заголовка делаем короткую паузу,
// остальные строки просто склеиваются — знаки препинания Silero отработает сам.
function linesToContent(lines) {
  const pieces = [];
  lines.forEach((line, index) => {
    pieces.push(sentenceTags(line));
    if (index < lines.length - 1 && isHeading(line)) pieces.push(breakTag(PAUSE_MS.headingBefore));
  });
  return pieces.filter(Boolean).join(' ');
}

// Абзац → его тип и размеченное содержимое.
function classifyParagraph(lines) {
  if (lines.length > 1 && lines.every((line) => LIST_MARKER.test(line))) {
    return { kind: 'list', content: listTags(lines) };
  }
  if (lines.length === 1 && isHeading(lines[0])) {
    return { kind: 'heading', content: escapeXml(lines[0]) };
  }
  return { kind: 'body', content: linesToContent(lines) };
}

// Главная точка входа: подготовленный текст → SSML для Silero.
export function buildSsml(text) {
  const paragraphs = toParagraphs(text);
  if (paragraphs.length === 0) return '<speak></speak>';

  const parts = paragraphs.map(classifyParagraph);
  const pieces = [];

  parts.forEach((part, index) => {
    if (index > 0) {
      // Одна пауза на стык: у заголовка она своя, у обычных абзацев — длиннее.
      const touchesHeading = part.kind === 'heading' || parts[index - 1].kind === 'heading';
      pieces.push(breakTag(touchesHeading ? PAUSE_MS.headingAfter : PAUSE_MS.paragraph));
    }
    pieces.push(part.content);
  });

  // Темп задаётся вокруг всего текста: внутри тега остаются и паузы <break>,
  // это проверено — они работают вместе.
  return `<speak>${rateTag(pieces.join(''))}</speak>`;
}

// Для отладки: во что превратился текст перед синтезом.
export function describeProsody(text) {
  const ssml = buildSsml(text);
  return {
    prosody: ssml,
    breaks: (ssml.match(/<break time="(\d+)ms"\/>/g) ?? []).length,
    paragraphs: toParagraphs(text).length,
  };
}
