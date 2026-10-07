// Genera el script de recuperación que corre en el navegador (clásico, sin módulos,
// antes del bundle). Ver docs/cloudflare-pages.md → "Recuperación".

export const GUARD_FILE = 'stale-asset-guard.js';

/**
 * Posición del <script> que carga el guard, o -1 si no hay. Busca la etiqueta real:
 * una mención del nombre en un comentario o en texto no cuenta.
 */
export function findGuardScript(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  return withoutComments.search(/<script\b[^>]*\bsrc=["'][^"']*stale-asset-guard\.js[^"']*["']/i);
}

const DEFAULT_TEXTS = {
  updatingTitle: 'Actualizando la página…',
  updatingBody: 'Estamos cargando la versión más reciente. Solo tomará unos segundos.',
  failedTitle: 'No pudimos cargar la página',
  failedBody: 'Revisa tu conexión e inténtalo de nuevo.',
  retry: 'Reintentar',
};

/**
 * @param {{ assetPrefixes?: string[], texts?: Partial<typeof DEFAULT_TEXTS>, logo?: string }} [options]
 *   `logo`: URL de una imagen (sin hash, p. ej. "/logo.png") que se muestra en la pantalla de espera.
 * @returns {string} código JS listo para servir como /stale-asset-guard.js
 */
export function buildGuardScript(options = {}) {
  const config = {
    prefixes: options.assetPrefixes?.length ? options.assetPrefixes : ['/assets/'],
    texts: { ...DEFAULT_TEXTS, ...options.texts },
    logo: typeof options.logo === 'string' ? options.logo : '',
  };
  return `// safe-deploy: recuperación cuando un archivo con hash no carga. NO editar: se genera en el build.
//
// Dos causas posibles:
//   a) HTML viejo (pestaña restaurada, caché) que pide hashes que ya no existen: basta recargar.
//   b) HTML nuevo cuyos assets aún se están propagando en el CDN (segundos): hay que esperar.
//      Además el navegador guarda ese 404 durante horas: se vuelve a pedir con cache:'reload'.
(${guardRuntime.toString()})(${JSON.stringify(config)});
`;
}

// Se serializa con toString(): debe ser ES5 y no usar nada de fuera de la función.
function guardRuntime(config) {
  var STALE_KEY = 'stale-asset-reload-at';
  var RELOADS_KEY = 'stale-asset-reloads';
  var STALE_COOLDOWN_MS = 30000;
  var RETRY_MS = 1500;
  var MAX_RETRIES = 60; // ~90 s
  var MAX_RELOADS = 4; // por ventana de 2 min: evita bucles si algo más está roto
  var RELOADS_WINDOW_MS = 120000;
  var T = config.texts;

  var busy = false;
  var overlay = null;
  var overlayState = null; // null = sin mostrar, false = "actualizando", true = "falló"

  function read(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { sessionStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  // false si ya se agotaron las recargas (o no hay sessionStorage: sin él no hay
  // forma segura de evitar un bucle).
  function registerReload() {
    var now = Date.now();
    var recent = [];
    try { recent = JSON.parse(read(RELOADS_KEY) || '[]'); } catch (e) { recent = []; }
    recent = recent.filter(function (t) { return now - t < RELOADS_WINDOW_MS; });
    if (recent.length >= MAX_RELOADS) return false;
    recent.push(now);
    return write(RELOADS_KEY, JSON.stringify(recent));
  }

  function reload() {
    if (!registerReload()) { showOverlay(true); return; }
    var url = new URL(window.location.href);
    url.searchParams.set('_cb', String(Date.now()));
    window.location.replace(url.toString());
  }

  function showOverlay(failed) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { showOverlay(failed); });
      return;
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'status');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;' +
        'background:#0f0f10;color:#f4f4f5;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
      document.body.appendChild(overlay);
    }
    // Se reintenta cada 1.5 s: no reconstruir si ya muestra ese estado (reiniciaría la animación).
    if (overlayState === failed) return;
    overlayState = failed;
    overlay.textContent = '';

    if (config.logo) {
      var logo = document.createElement('img');
      logo.alt = '';
      logo.style.cssText = 'max-height:56px;max-width:60vw;margin-bottom:8px';
      logo.onerror = function () { if (logo.parentNode) logo.parentNode.removeChild(logo); };
      logo.src = config.logo;
      overlay.appendChild(logo);
    }

    var title = document.createElement('div');
    title.style.cssText = 'font-size:1.25rem;font-weight:700';
    // Los puntos animados de abajo hacen de "…": se quitan del título para no duplicarlos.
    title.textContent = failed ? T.failedTitle : T.updatingTitle.replace(/(…|\.{3})\s*$/, '');
    var text = document.createElement('div');
    text.style.cssText = 'color:#a1a1aa;max-width:22rem';
    text.textContent = failed ? T.failedBody : T.updatingBody;
    overlay.appendChild(title);

    if (!failed) {
      // Tres puntos que suben y bajan en cadena. Web Animations API: no necesita <style>,
      // así que funciona aunque el sitio tenga una CSP que prohíba estilos en línea.
      var dots = document.createElement('div');
      dots.setAttribute('aria-hidden', 'true');
      dots.style.cssText = 'display:flex;gap:8px;height:18px;align-items:center';
      for (var i = 0; i < 3; i++) {
        var dot = document.createElement('span');
        dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f4f4f5;opacity:.3';
        dots.appendChild(dot);
        if (dot.animate) {
          dot.animate(
            [
              { opacity: 0.3, transform: 'translateY(0)' },
              { opacity: 1, transform: 'translateY(-6px)', offset: 0.3 },
              { opacity: 0.3, transform: 'translateY(0)', offset: 0.6 },
              { opacity: 0.3, transform: 'translateY(0)' }
            ],
            { duration: 1200, iterations: Infinity, delay: i * 180 }
          );
        }
      }
      overlay.appendChild(dots);
    }

    overlay.appendChild(text);
    if (failed) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = T.retry;
      button.style.cssText = 'padding:0.6rem 1.2rem;border:0;border-radius:8px;background:#f4f4f5;' +
        'color:#0f0f10;font-weight:600;font-size:1rem;cursor:pointer';
      button.onclick = function () {
        try { sessionStorage.removeItem(RELOADS_KEY); } catch (e) { /* noop */ }
        reload();
      };
      overlay.appendChild(button);
    }
  }

  // cache:'reload' ignora (y reemplaza) el 404 que el navegador tenga guardado.
  // Un 404 de hosting estático suele ser HTML, por eso también se revisa el tipo.
  function assetIsAvailable(url) {
    return fetch(url, { cache: 'reload' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      return res.ok && type.indexOf('text/html') === -1;
    }, function () { return false; });
  }

  function attempt(url, n) {
    assetIsAvailable(url).then(function (available) {
      if (available) { reload(); return; }

      // Primera vez que falla: quizá el HTML es viejo y una recarga lo arregla.
      var lastStale = Number(read(STALE_KEY) || 0);
      if (n === 0 && Date.now() - lastStale > STALE_COOLDOWN_MS && write(STALE_KEY, String(Date.now()))) {
        reload();
        return;
      }

      // Ya se recargó y sigue sin existir: el deploy se está propagando. Esperar.
      if (n >= MAX_RETRIES) { showOverlay(true); return; }
      showOverlay(false);
      setTimeout(function () { attempt(url, n + 1); }, RETRY_MS);
    });
  }

  function isHashedAsset(url) {
    if (!url) return false;
    for (var i = 0; i < config.prefixes.length; i++) {
      if (url.indexOf(window.location.origin + config.prefixes[i]) === 0) return true;
    }
    return false;
  }

  function recover(url) {
    if (busy) return;
    busy = true;
    if (!url || !window.fetch) { reload(); return; }
    attempt(url, 0);
  }

  // La usan los manejadores de chunks de carga diferida (safe-deploy/client).
  window.__recoverStaleAsset = function (url) {
    if (!url || isHashedAsset(url)) recover(url);
  };

  window.addEventListener('error', function (event) {
    var el = event.target;
    if (!el || el === window || !el.tagName) return;
    var url = '';
    if (el.tagName === 'SCRIPT') url = el.src;
    else if (el.tagName === 'LINK' && (el.rel === 'stylesheet' || el.rel === 'modulepreload')) url = el.href;
    if (isHashedAsset(url)) recover(url);
  }, true);
}
