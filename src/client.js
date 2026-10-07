// Recuperación de chunks de carga diferida (React.lazy, import() dinámico).
// Se instala una vez, al inicio de la app:  installChunkRecovery()
//
// stale-asset-guard.js cubre los <script>/<link> del HTML; esto cubre los import() que
// fallan después, y delega en el guard (window.__recoverStaleAsset) para esperar al
// asset y limpiar el 404 que el navegador haya guardado.

const CHUNK_ERROR_PATTERNS = [
  'ChunkLoadError',
  'Failed to fetch dynamically imported module', // Chrome / Edge
  'Importing a module script failed', // Safari
  'error loading dynamically imported module', // Firefox
  'Expected a JavaScript-or-Wasm module script',
  'MIME type of "text/html"',
  'Unable to preload CSS',
];

const COOLDOWN_KEY = 'chunk_failed_reload_time';
const COOLDOWN_MS = 30000;

/** ¿El mensaje de error corresponde a un chunk/asset que no se pudo cargar? */
export function isChunkLoadFailure(message) {
  const text = String(message ?? '');
  return CHUNK_ERROR_PATTERNS.some((p) => text.includes(p));
}

/**
 * Intenta recuperar la página tras un fallo de chunk. Devuelve true si inició la
 * recuperación (y por tanto la página va a recargarse).
 */
export function recoverFromChunkError(message = '') {
  const now = Date.now();
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(COOLDOWN_KEY) || 0);
  } catch {
    return false; // sin sessionStorage no hay forma segura de evitar un bucle
  }
  if (now - last < COOLDOWN_MS) return false;
  try {
    sessionStorage.setItem(COOLDOWN_KEY, String(now));
  } catch {
    return false;
  }

  const failedUrl = String(message).match(/https?:\/\/[^\s'"]+/)?.[0];
  if (typeof window.__recoverStaleAsset === 'function' && failedUrl?.startsWith(window.location.origin)) {
    window.__recoverStaleAsset(failedUrl);
  } else {
    const url = new URL(window.location.href);
    url.searchParams.set('_cb', String(now));
    window.location.replace(url.toString());
  }
  return true;
}

let installed = false;

/** Escucha los errores de carga de chunks y recupera la página. Idempotente. */
export function installChunkRecovery() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('vite:preloadError', (event) => {
    recoverFromChunkError(String(event.payload ?? ''));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = String(event.reason);
    if (isChunkLoadFailure(reason) && recoverFromChunkError(reason)) event.preventDefault();
  });

  window.addEventListener(
    'error',
    (event) => {
      const message = String(event.message || '');
      if (isChunkLoadFailure(message)) recoverFromChunkError(message);
    },
    true,
  );
}
