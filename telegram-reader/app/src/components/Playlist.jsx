// Плейлист: компактный список на основном экране и оверлей редактирования.
//
// Компактный вид показывает не больше пяти строк (дальше внутренняя прокрутка) и только
// две подписи на пост — источник и первую строку — плюс состояние:
//   ▶ играет, Ⅱ на паузе, ✓ прослушан, пусто — обычный пост.
// Прослушанные посты остаются в списке: их помечает плеер, когда пост доигран.
//
// Оверлей — тот же список на весь экран: выбор поста, удаление и перетаскивание порядка.
// Перетаскивание сделано на Pointer Events, а не на HTML5 drag&drop: в мобильном вебвью
// HTML5-перетаскивание не работает. Пока список открыт, плеер не перезапускается —
// аудиоэлемент живёт в App и на время открытия оверлея не пересоздаётся.
import { useRef, useState } from 'react';

function stateIcon(entry, currentId, playing) {
  if (entry.id === currentId) return playing ? '▶' : 'Ⅱ';
  return entry.played ? '✓' : '';
}

function RowBody({ entry, currentId, playing }) {
  return (
    <>
      <span className="row-source">{entry.source}</span>
      <span className="row-line">{entry.firstLine || 'Текст поста не получен'}</span>
      <span className="row-state" aria-hidden="true">
        {stateIcon(entry, currentId, playing)}
      </span>
    </>
  );
}

// Компактный список на основном экране.
export function PlaylistCompact({ entries, currentId, playing, missingId, onSelect }) {
  return (
    <div className="playlist" role="listbox" aria-label="Плейлист">
      <ul className="playlist-rows">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              role="option"
              aria-selected={entry.id === currentId}
              className={`row ${entry.id === currentId ? 'is-current' : ''} ${entry.id === missingId ? 'is-missing' : ''} ${entry.played && entry.id !== currentId ? 'is-played' : ''}`}
              onClick={() => onSelect(entry.id)}
            >
              <RowBody entry={entry} currentId={currentId} playing={playing} />
            </button>
          </li>
        ))}
      </ul>
      {entries.length > 5 ? <p className="playlist-hint">ПРОКРУТКА · {entries.length} ПОСТОВ</p> : null}
    </div>
  );
}

// Оверлей редактирования: полный список с перетаскиванием и удалением.
// Кнопка «Очистить плейлист» чистит очередь только на устройстве: она нужна, когда
// backend недоступен и синхронизация не может убрать записи сама.
export function PlaylistEditor({ entries, currentId, playing, missingId, open, onSelect, onReorder, onRemove, onClear, onDone }) {
  const [drag, setDrag] = useState(null);
  const rowRefs = useRef([]);

  const startDrag = (event, index) => {
    const row = rowRefs.current[index];
    if (!row) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      index,
      target: index,
      startY: event.clientY,
      pointerId: event.pointerId,
      // Шаг списка: высота строки вместе с промежутком.
      rowHeight: row.getBoundingClientRect().height + 10,
      dy: 0,
    });
  };

  const moveDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = event.clientY - drag.startY;
    const shift = Math.round(dy / drag.rowHeight);
    const target = Math.max(0, Math.min(entries.length - 1, drag.index + shift));
    setDrag((prev) => (prev ? { ...prev, dy, target } : prev));
  };

  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    if (drag.target !== drag.index) onReorder(drag.index, drag.target);
    setDrag(null);
  };

  // Сдвиг строк вокруг перетаскиваемой: она едет за пальцем, остальные уступают место.
  const offsetFor = (index) => {
    if (!drag) return 0;
    if (index === drag.index) return drag.dy;
    const { index: from, target, rowHeight } = drag;
    if (from < target && index > from && index <= target) return -rowHeight;
    if (from > target && index < from && index >= target) return rowHeight;
    return 0;
  };

  return (
    <div className={`editor ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="editor-backdrop" onClick={onDone} />
      <section className="editor-sheet" aria-label="Редактирование плейлиста">
        <header className="editor-head">
          <span className="editor-title">ПЛЕЙЛИСТ</span>
          <span className="editor-count">{entries.length} ПОСТОВ</span>
        </header>

        <ul className="editor-rows">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              className={`editor-row ${index === drag?.index ? 'is-dragging' : ''} ${entry.id === currentId ? 'is-current' : ''} ${entry.id === missingId ? 'is-missing' : ''}`}
              style={{ transform: `translateY(${offsetFor(index)}px)` }}
            >
              <button
                type="button"
                className="row-handle"
                aria-label={`Переместить пост ${entry.source}`}
                onPointerDown={(event) => startDrag(event, index)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                ⠿
              </button>

              <button type="button" className="row-main" onClick={() => onSelect(entry.id)}>
                <RowBody entry={entry} currentId={currentId} playing={playing} />
              </button>

              <button
                type="button"
                className="row-remove"
                aria-label={`Убрать пост ${entry.source} из плейлиста`}
                onClick={() => onRemove(entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        <button type="button" className="btn btn-wide editor-clear" onClick={onClear}>
          ОЧИСТИТЬ ПЛЕЙЛИСТ
        </button>

        <button type="button" className="btn btn-wide btn-primary editor-done" onClick={onDone}>
          ГОТОВО
        </button>
      </section>
    </div>
  );
}
