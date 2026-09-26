// Аудиодвижок Mini App: текст поста из API, аудио из кэша backend, воспроизведение
// частями. Логика взята из прежней версии приложения (загрузка поста → POST /audio →
// скачивание Blob → object URL → плеер) и дополнена переключением постов.
//
// Состояния статуса:
//   idle            — поста нет (пустой плейлист)
//   loading         — получаем текст поста
//   generating      — backend синтезирует или отдаёт готовое аудио
//   ready           — аудио загружено, можно играть
//   not_implemented — провайдер TTS не подключён (не ошибка приложения)
//   error           — пост недоступен или запрос не удался
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  checkEnvironment,
  describeFetchError,
  downloadAudio,
  fetchPost,
  releaseAudio,
  requestAudio,
} from './api.js';

const EMPTY = {
  postId: null,
  status: 'idle',
  error: null,
  errorCode: null,
  chunks: 0,
  voice: null,
  cached: false,
  chunkIndex: 0,
};

export function usePlayer({ onPostLoaded, onEnded, rate = 1 } = {}) {
  const audioRef = useRef(null);
  const urlsRef = useRef([]);
  const chunkRef = useRef(0);
  const autoplayRef = useRef(false);
  const requestRef = useRef(null);
  // Скорость воспроизведения применяется к самому аудиоэлементу: TTS не пересчитывается.
  const rateRef = useRef(rate);
  rateRef.current = rate;
  // Номер загрузки: ответы устаревших запросов (пользователь быстро переключает посты)
  // не должны переписывать состояние.
  const sequenceRef = useRef(0);
  const postIdRef = useRef(null);

  const onPostLoadedRef = useRef(onPostLoaded);
  const onEndedRef = useRef(onEnded);
  onPostLoadedRef.current = onPostLoaded;
  onEndedRef.current = onEnded;

  const [state, setState] = useState(EMPTY);
  const [audio, setAudio] = useState({ playing: false, currentTime: 0, duration: 0, error: null });

  const releaseUrls = useCallback(() => {
    releaseAudio(urlsRef.current);
    urlsRef.current = [];
  }, []);

  const reset = useCallback(() => {
    requestRef.current?.abort();
    sequenceRef.current += 1;
    releaseUrls();
    postIdRef.current = null;
    chunkRef.current = 0;
    autoplayRef.current = false;
    setState(EMPTY);
    setAudio({ playing: false, currentTime: 0, duration: 0, error: null });
  }, [releaseUrls]);

  // Загрузка поста: сначала текст, затем аудио нужным голосом.
  // Предыдущий запрос отменяется только началом новой загрузки: очистка эффекта
  // в StrictMode отменила бы единственную загрузку, и экран остался бы без поста.
  const load = useCallback(
    async (id, { voice = null, autoplay = false } = {}) => {
      const environmentError = checkEnvironment();
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;

      releaseUrls();
      postIdRef.current = id;
      chunkRef.current = 0;
      autoplayRef.current = autoplay;

      if (environmentError) {
        setState({ ...EMPTY, postId: id, status: 'error', error: environmentError });
        return;
      }

      setState({ ...EMPTY, postId: id, status: 'loading' });
      setAudio({ playing: false, currentTime: 0, duration: 0, error: null });

      let post;
      try {
        post = await fetchPost(id, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          ...EMPTY,
          postId: id,
          status: 'error',
          error: describeFetchError(error),
          errorCode: error instanceof ApiError ? error.code : null,
        });
        return;
      }
      if (sequence !== sequenceRef.current) return;

      onPostLoadedRef.current?.({ id, text: post.text, createdAt: post.createdAt });

      setState((prev) => ({ ...prev, status: 'generating' }));
      let payload;
      let objectUrls;
      try {
        payload = await requestAudio(id, { voice, signal: controller.signal });
        if (payload.status === 'not_implemented') {
          setState({ ...EMPTY, postId: id, status: 'not_implemented', error: payload.message ?? null });
          return;
        }
        if (!Array.isArray(payload.audioUrls) || payload.audioUrls.length === 0) {
          throw new Error('backend не вернул ссылку на аудио');
        }
        objectUrls = await downloadAudio(payload.audioUrls, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          ...EMPTY,
          postId: id,
          status: 'error',
          error: describeFetchError(error),
          errorCode: error instanceof ApiError ? error.code : null,
        });
        return;
      }
      if (sequence !== sequenceRef.current) {
        releaseAudio(objectUrls);
        return;
      }

      urlsRef.current = objectUrls;
      setState({
        postId: id,
        status: 'ready',
        error: null,
        errorCode: null,
        chunks: payload.chunks ?? objectUrls.length,
        voice: payload.voice ?? voice ?? null,
        cached: Boolean(payload.cached),
        chunkIndex: 0,
      });
    },
    [releaseUrls],
  );

  // Смена голоса: тот же пост, но синтез другим голосом (backend кэширует по голосу).
  const applyVoice = useCallback((id, voice) => load(id, { voice, autoplay: true }), [load]);

  // Подстановка источника: текущая часть, дальше при необходимости доигрываем следующую.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const url = state.status === 'ready' ? urlsRef.current[state.chunkIndex] : null;
    if (!url) {
      if (el.getAttribute('src')) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      return;
    }
    if (el.src !== url) {
      el.src = url;
      el.load();
      // Загрузка нового источника сбрасывает скорость — возвращаем выбранную.
      el.playbackRate = rateRef.current;
    }
    if (autoplayRef.current) {
      autoplayRef.current = false;
      // Автовоспроизведение может запретить браузер: это не ошибка приложения,
      // поэтому состояние остаётся «готово», а пользователь нажмёт play сам.
      el.play().catch(() => {});
    }
  }, [state.status, state.chunkIndex]);

  // Смена скорости во время воспроизведения: применяется сразу, без пересборки аудио.
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  // Состояние аудиоэлемента.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;

    const sync = () =>
      setAudio((prev) => ({
        ...prev,
        playing: !el.paused && !el.ended,
        currentTime: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : prev.duration,
      }));

    const handlers = {
      loadedmetadata: () => {
        sync();
        setAudio((prev) => ({ ...prev, error: null }));
      },
      play: sync,
      playing: sync,
      pause: sync,
      timeupdate: sync,
      ended: () => {
        if (chunkRef.current < urlsRef.current.length - 1) {
          autoplayRef.current = true;
          chunkRef.current += 1;
          setState((prev) => ({ ...prev, chunkIndex: chunkRef.current }));
          return;
        }
        // Пост доигран: следующий пост запускает вызывающий код; если его нет —
        // возвращаемся к первой части, чтобы Play читал пост сначала.
        const advanced = onEndedRef.current?.(postIdRef.current) ?? false;
        if (!advanced) {
          chunkRef.current = 0;
          setState((prev) => ({ ...prev, chunkIndex: 0 }));
        }
        sync();
      },
      error: () => setAudio((prev) => ({ ...prev, error: 'не удалось прочитать аудиофайл' })),
    };

    Object.entries(handlers).forEach(([name, handler]) => el.addEventListener(name, handler));
    sync();
    return () => Object.entries(handlers).forEach(([name, handler]) => el.removeEventListener(name, handler));
  }, []);

  const toggle = useCallback(async () => {
    const el = audioRef.current;
    if (!el || !el.getAttribute('src')) return;
    try {
      if (el.paused || el.ended) await el.play();
      else el.pause();
    } catch (error) {
      setAudio((prev) => ({ ...prev, error: error.message }));
    }
  }, []);

  const seek = useCallback((seconds) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
  }, []);

  return { audioRef, state, audio, load, applyVoice, toggle, seek, reset };
}
