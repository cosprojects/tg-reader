// POST READER — Mini App: плеер для постов из Telegram.
//
// Экран — сам плеер: сверху очередь (компактный список и кнопка редактирования),
// снизу «дека» управления, закреплённая у нижнего края viewport с учётом safe area.
//
// Очередь: посты приходят из backend (GET /api/queue по id пользователя Telegram) и из
// ссылки ?post=<id>; порядок, состояние «прослушан», текущий пост и голос хранятся
// на устройстве (playlist.js).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchQueue, fetchVoices } from './api.js';
import { PlaylistCompact, PlaylistEditor } from './components/Playlist.jsx';
import {
  formatTime,
  makeEntry,
  mergeQueue,
  moveEntry,
  neighbour,
  readPlaylist,
  removeEntry,
  savePlaylist,
  updateEntry,
  upsertEntry,
} from './playlist.js';
import { callReady, expandApp, getUserId, getWebApp, subscribe } from './telegram.js';
import { usePlayer } from './usePlayer.js';

// Пользователь видит только «мужской» и «женский», поэтому пол выбирается из
// установленных голосов модели по небольшой таблице. Порядок предпочтений важен:
// для мужского первым идёт голос по умолчанию backend — тогда готовое аудио поста
// играет сразу, без повторного синтеза.
const MALE_ORDER = ['eugene'];
const FEMALE_ORDER = ['baya', 'kseniya', 'xenia'];

// Скорость воспроизведения: три положения, по умолчанию 1.0×.
const RATES = [0.8, 1, 1.2];
const RATE_KEY = 'post-reader:rate:v1';
const QUEUE_REFRESH_MS = 15000;

function readRate() {
  const stored = Number(window.localStorage.getItem(RATE_KEY));
  return RATES.includes(stored) ? stored : 1;
}

function pickVoice(gender, available, defaultVoice) {
  const order = gender === 'male' ? [defaultVoice, 'aidar', ...MALE_ORDER] : FEMALE_ORDER;
  return order.find((name) => name && available.includes(name)) ?? null;
}

export default function App() {
  const [entries, setEntries] = useState(readPlaylist);
  const [currentId, setCurrentId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [gender, setGender] = useState('male');
  const [rate, setRate] = useState(readRate);
  const [voices, setVoices] = useState({ available: [], default: null });
  const [missingId, setMissingId] = useState(null);
  const [finished, setFinished] = useState(false);
  const [userId, setUserId] = useState(null);
  // Связь с сервером: по ней видно, синхронизируется ли очередь и можно ли полагаться
  // на очистку через бота. Плейлист при сбое не выкидываем.
  const [sync, setSync] = useState({ state: 'idle', at: null });

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // Идентификатор поста из ссылки бота читается один раз: стартовая загрузка не
  // должна повторяться на каждом рендере.
  const initialId = useMemo(() => new URLSearchParams(window.location.search).get('post'), []);

  // Завершение поста обрабатывает App (пометить прослушанным и решить, что дальше),
  // но движок создаётся раньше — поэтому колбэк ходит через ref.
  const handleEndedRef = useRef(() => false);

  // Движок: посты, аудио, части, скорость.
  const { audioRef, state, audio, load, applyVoice, toggle, seek, reset } = usePlayer({
    rate,
    onPostLoaded: ({ id, text, createdAt }) => {
      setEntries((prev) => upsertEntry(prev, makeEntry({ id, text, createdAt })).entries);
    },
    onEnded: (id) => handleEndedRef.current(id),
  });

  const playPost = useCallback(
    (entry, { autoplay = true } = {}) => {
      if (!entry) return false;
      setCurrentId(entry.id);
      setMissingId(null);
      setFinished(false);
      load(entry.id, { voice: entry.appliedVoice ?? null, autoplay });
      return true;
    },
    [load],
  );

  const playNeighbour = useCallback(
    (id, step) => {
      const target = neighbour(entriesRef.current, id, step);
      if (!target) return false;
      return playPost(target);
    },
    [playPost],
  );

  // 1. Старт: пост из ссылки бота становится текущим.
  useEffect(() => {
    if (!initialId) return;
    const known = entriesRef.current.find((entry) => entry.id === initialId);
    playPost(known ?? { id: initialId, appliedVoice: null }, { autoplay: true });
  }, [initialId, playPost]);

  // 2. Плейлист сохраняется между открытиями Mini App, скорость — вместе с ним.
  useEffect(() => {
    savePlaylist(entries);
  }, [entries]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // Приватный режим браузера может запретить запись: скорость живёт одну сессию.
    }
  }, [rate]);

  // 3. Telegram WebApp: ready() задаёт высоту, expand() разворачивает плеер на весь экран.
  useEffect(() => {
    const wa = getWebApp();
    callReady(wa);
    expandApp(wa);
    // В браузере (без Telegram) пользователя можно передать параметром — удобно для проверок.
    setUserId(getUserId(wa) ?? new URLSearchParams(window.location.search).get('user'));
  }, []);

  // 4. Очередь backend: кнопка «🎧 Слушать» открывает плеер без ссылки на пост,
  // поэтому новые посты подтягиваются из /api/queue — при открытии, при возврате
  // в приложение и раз в 15 секунд.
  useEffect(() => {
    if (!userId) return undefined;

    const controller = new AbortController();
    let alive = true;

    const refresh = async () => {
      try {
        const data = await fetchQueue(userId, { signal: controller.signal });
        if (!alive) return;
        // prune: если очередь на backend очистили (/reset), записи уходят и из плейлиста.
        setEntries((prev) => mergeQueue(prev, data.posts ?? [], { prune: true }).entries);
        setSync({ state: 'ok', at: Date.now() });
      } catch {
        // Сеть или backend недоступны: плейлист не трогаем, но говорим об этом в плеере.
        if (alive) setSync({ state: 'failed', at: Date.now() });
      }
    };

    refresh();
    const timer = setInterval(refresh, QUEUE_REFRESH_MS);
    const unsubscribe = subscribe(getWebApp(), 'activated', refresh);

    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
    };
  }, [userId]);

  // 5. Пустая очередь и есть посты на backend: показываем первый, но сами не запускаем.
  useEffect(() => {
    if (currentIdRef.current || entries.length === 0) return;
    playPost(entries[0], { autoplay: false });
  }, [entries, playPost]);

  // 6. Голоса: нужны, чтобы «мужской/женский» соответствовали реально установленным.
  useEffect(() => {
    const controller = new AbortController();
    fetchVoices({ signal: controller.signal })
      .then((data) => {
        const list = data.voices ?? data.providers?.silero ?? [];
        setVoices({ available: list.map((voice) => voice.name), default: data.default ?? list[0]?.name ?? null });
      })
      .catch(() => {
        // Без списка голосов доступен только голос по умолчанию backend.
      });
    return () => controller.abort();
  }, []);

  // 7. Голос, которым озвучен текущий пост: помним его в записи плейлиста.
  const appliedVoice = state.postId === currentId ? state.voice : null;
  const currentVoice = appliedVoice ?? entries.find((entry) => entry.id === currentId)?.appliedVoice ?? null;

  useEffect(() => {
    if (appliedVoice && currentId) {
      setEntries((prev) => updateEntry(prev, currentId, { appliedVoice }));
    }
  }, [appliedVoice, currentId]);

  useEffect(() => {
    if (state.errorCode === 'post_not_found' && state.postId) setMissingId(state.postId);
  }, [state.errorCode, state.postId]);

  const selectVoice = useCallback((next) => setGender(next), []);

  const selectedVoice = useMemo(
    () => pickVoice(gender, voices.available, voices.default),
    [gender, voices],
  );

  const currentIndex = entries.findIndex((entry) => entry.id === currentId);
  const currentEntry = currentIndex === -1 ? null : entries[currentIndex];
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex !== -1 && currentIndex < entries.length - 1;

  const selectPost = useCallback(
    (id) => {
      if (id === currentId && state.status === 'ready') {
        // Тот же пост: продолжаем воспроизведение, а не перезагружаем аудио.
        if (!audio.playing) toggle();
        return;
      }
      const entry = entriesRef.current.find((item) => item.id === id);
      playPost(entry, { autoplay: true });
    },
    [currentId, state.status, audio.playing, toggle, playPost],
  );

  const startEditing = useCallback(() => setEditing(true), []);
  const finishEditing = useCallback(() => setEditing(false), []);

  const reorder = useCallback((from, to) => {
    setEntries((prev) => moveEntry(prev, from, to));
  }, []);

  const removePost = useCallback(
    (id) => {
      const previous = entriesRef.current;
      const next = removeEntry(previous, id);
      setEntries(next);
      if (id === missingId) setMissingId(null);

      // Убрали текущий пост — берём следующий, иначе предыдущий.
      if (id !== currentIdRef.current) return;
      const fallback = neighbour(previous, id, 1) ?? neighbour(previous, id, -1);
      if (fallback) {
        playPost(fallback);
        return;
      }
      reset();
      setCurrentId(null);
      setFinished(false);
    },
    [missingId, playPost, reset],
  );

  // Локальная очистка: плейлист живёт на устройстве, поэтому работает и без сервера.
  const clearPlaylist = useCallback(() => {
    reset();
    setEntries([]);
    setCurrentId(null);
    setFinished(false);
    setEditing(false);
  }, [reset]);

  const retry = useCallback(() => {
    if (currentEntry) playPost(currentEntry, { autoplay: true });
    else if (initialId) playPost({ id: initialId, appliedVoice: null }, { autoplay: true });
  }, [currentEntry, initialId, playPost]);

  // Доигранный пост помечаем прослушанным, следующий запускает движок сам.
  // Если следующего нет — пост остаётся текущим, а плеер показывает завершение.
  const handleEnded = useCallback(
    (id) => {
      setEntries((prev) => updateEntry(prev, id, { played: true }));
      const advanced = playNeighbour(id, 1);
      if (!advanced) setFinished(true);
      return advanced;
    },
    [playNeighbour],
  );

  useEffect(() => {
    handleEndedRef.current = handleEnded;
  }, [handleEnded]);

  const failure = state.status === 'error' || state.status === 'not_implemented';
  const showEmptyState = entries.length === 0 && !failure;
  const status = state.status === 'loading' ? 'ПОЛУЧАЕМ ПОСТ…' : state.status === 'generating' ? 'ОЗВУЧИВАЮ…' : null;
  const isReady = state.status === 'ready';
  const isGenerating = state.status === 'loading' || state.status === 'generating';
  const timelineMax = audio.duration > 0 ? audio.duration : 0.001;
  const applyDisabled = !currentEntry || !selectedVoice || isGenerating || selectedVoice === currentVoice;

  return (
    <>
      <audio ref={audioRef} preload="metadata" />
      <div className="app">
        <div className="device">
        <div className="device-queue">
          {showEmptyState ? (
            <div className="display" role="status">
              <p className="display-empty">Отправьте пост боту — он появится здесь.</p>
            </div>
          ) : (
            <>
              {entries.length > 0 ? (
                <>
                  <PlaylistCompact
                    entries={entries}
                    currentId={currentId}
                    playing={audio.playing}
                    missingId={missingId}
                    onSelect={selectPost}
                  />
                  <div className="edit-control">
                    <button type="button" className="btn btn-small" onClick={editing ? finishEditing : startEditing}>
                      {editing ? 'ГОТОВО' : 'ИЗМЕНИТЬ'}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>

        <div className="device-player">
          <section className="display" aria-live="polite">
            <div className="display-top">
              <span className="display-source">
                {sync.state === 'failed' ? 'НЕТ СВЯЗИ · ' : ''}
                {currentEntry?.source ?? 'ПОСТ'}
              </span>
              {state.chunks > 1 ? (
                <span className="display-part">
                  ЧАСТЬ {Math.min(state.chunkIndex + 1, state.chunks)}/{state.chunks}
                </span>
              ) : null}
            </div>

            {state.status === 'error' ? (
              <div className="display-error">
                <p className="display-line">{state.error}</p>
                <button type="button" className="btn btn-small" onClick={retry}>
                  ПОВТОРИТЬ
                </button>
              </div>
            ) : state.status === 'not_implemented' ? (
              <p className="display-line">{state.error ?? 'Аудио недоступно: провайдер TTS не подключён.'}</p>
            ) : (
              <p className={`display-line ${status || finished ? 'is-muted' : ''}`}>
                {status ?? (finished ? '✓ Пост прослушан' : currentEntry?.firstLine ?? '')}
              </p>
            )}
          </section>

          <section className="transport">
            <input
              className="timeline"
              type="range"
              min="0"
              max={timelineMax}
              step="0.1"
              value={Math.min(audio.currentTime, timelineMax)}
              onChange={(event) => seek(Number(event.target.value))}
              disabled={!isReady}
              aria-label="Позиция воспроизведения"
            />

            <div className="time-row">
              <span className="time">{formatTime(audio.currentTime)}</span>
              <span className="time">{audio.error ? 'ОШИБКА ПЛЕЕРА' : formatTime(audio.duration)}</span>
            </div>

            <div className="buttons">
              <button type="button" className="btn btn-key" onClick={() => playNeighbour(currentId, -1)} disabled={!hasPrevious} aria-label="Предыдущий пост">
                ←
              </button>
              <button
                type="button"
                className="btn btn-play"
                onClick={toggle}
                disabled={!isReady}
                aria-label={audio.playing ? 'Пауза' : 'Играть'}
              >
                {audio.playing ? 'Ⅱ' : '▶'}
              </button>
              <button type="button" className="btn btn-key" onClick={() => playNeighbour(currentId, 1)} disabled={!hasNext} aria-label="Следующий пост">
                →
              </button>
            </div>
          </section>

          <section className="voice">
            <div className="voice-title">ГОЛОС</div>
            <div className="voice-buttons" role="group" aria-label="Выбор голоса">
              <button
                type="button"
                className={`btn btn-voice ${gender === 'male' ? 'is-selected' : ''}`}
                aria-pressed={gender === 'male'}
                onClick={() => selectVoice('male')}
              >
                МУЖСКОЙ
              </button>
              <button
                type="button"
                className={`btn btn-voice ${gender === 'female' ? 'is-selected' : ''}`}
                aria-pressed={gender === 'female'}
                onClick={() => selectVoice('female')}
              >
                ЖЕНСКИЙ
              </button>
            </div>

            <div className="speed">
              <div className="speed-head">
                <span className="voice-title">СКОРОСТЬ</span>
                <span className="speed-value">{rate.toFixed(1)}×</span>
              </div>
              <input
                className="speed-slider"
                type="range"
                min="0"
                max={RATES.length - 1}
                step="1"
                value={RATES.indexOf(rate)}
                onChange={(event) => setRate(RATES[Number(event.target.value)])}
                aria-label="Скорость воспроизведения"
              />
              <div className="speed-labels" aria-hidden="true">
                {RATES.map((value) => (
                  <span key={value} className={value === rate ? 'is-active' : ''}>
                    {value.toFixed(1)}
                  </span>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-wide btn-primary"
              onClick={() => currentEntry && selectedVoice && applyVoice(currentEntry.id, selectedVoice)}
              disabled={applyDisabled}
            >
              {isGenerating ? 'ОЗВУЧИВАЮ…' : 'ОЗВУЧИТЬ'}
            </button>
          </section>
        </div>
        </div>
      </div>

      <PlaylistEditor
        entries={entries}
        currentId={currentId}
        playing={audio.playing}
        missingId={missingId}
        open={editing}
        onSelect={selectPost}
        onReorder={reorder}
        onRemove={removePost}
        onClear={clearPlaylist}
        onDone={finishEditing}
      />
    </>
  );
}