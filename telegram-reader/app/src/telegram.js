// Обёртка над Telegram.WebApp. Всё вызывается безопасно: страница должна
// открываться и в обычном браузере (без window.Telegram), иначе её нельзя отлаживать.

export function getWebApp() {
  return globalThis.Telegram?.WebApp ?? null;
}

export function getInitUser(wa) {
  return wa?.initDataUnsafe?.user ?? null;
}

export function getInitDataLength(wa) {
  return typeof wa?.initData === 'string' ? wa.initData.length : 0;
}

// Снимок диагностических полей WebApp. Возвращаем именно то, что нужно для
// эксперимента со сворачиванием: isActive, видимость, размеры viewport.
export function readWebAppState(wa) {
  if (!wa) {
    return {
      available: false,
      version: null,
      isActive: null,
      isExpanded: null,
      viewportHeight: null,
      viewportStableHeight: null,
    };
  }
  return {
    available: true,
    version: wa.version ?? null,
    isActive: typeof wa.isActive === 'boolean' ? wa.isActive : null,
    isExpanded: typeof wa.isExpanded === 'boolean' ? wa.isExpanded : null,
    viewportHeight: typeof wa.viewportHeight === 'number' ? Math.round(wa.viewportHeight) : null,
    viewportStableHeight:
      typeof wa.viewportStableHeight === 'number' ? Math.round(wa.viewportStableHeight) : null,
  };
}

// Подписка на события WebApp с безопасным откатом: в старых клиентах onEvent может отсутствовать.
export function subscribe(wa, event, handler) {
  if (!wa || typeof wa.onEvent !== 'function') return () => {};
  wa.onEvent(event, handler);
  return () => {
    if (typeof wa.offEvent === 'function') wa.offEvent(event, handler);
  };
}

export function callReady(wa) {
  if (wa && typeof wa.ready === 'function') wa.ready();
}

// Разворачиваем Mini App на всю доступную высоту: иначе Telegram откроет его
// компактной панелью, и плеер окажется зажат.
export function expandApp(wa) {
  if (wa && typeof wa.expand === 'function') wa.expand();
}

export function getUserId(wa) {
  const id = getInitUser(wa)?.id;
  return id === undefined || id === null ? null : String(id);
}
