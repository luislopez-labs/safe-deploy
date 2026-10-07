// Archivos de configuración de Cloudflare Pages: 404.html, _redirects y _headers.
//
// Si el proyecto ya trae alguno (en public/), NO se sobrescribe: se revisa y se
// avisa de los errores conocidos. Si falta, se genera. El porqué de cada regla está
// en docs/cloudflare-pages.md.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findGuardScript, GUARD_FILE } from './guard.js';

const read = (path) => readFile(path, 'utf8').catch(() => null);

// ── 404.html ────────────────────────────────────────────────────────────────

export function build404Html(options = {}) {
  const {
    lang = 'es',
    title = 'Página no encontrada',
    message = 'La página que buscas no existe o fue movida.',
    homeLabel = 'Volver al inicio',
  } = options;
  return `<!doctype html>
<!--
  Página 404 de Cloudflare Pages (generada por safe-deploy). Su sola existencia desactiva
  el "modo SPA" de Pages, que responde index.html a cualquier ruta inexistente. Así un
  chunk viejo de /assets/* devuelve un 404 real y no HTML con status 200.
-->
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 16px; box-sizing: border-box; text-align: center;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f10; color: #f4f4f5;
    }
    h1 { font-size: 4rem; margin: 0; }
    p { margin: 0.5rem 0 1.5rem; color: #a1a1aa; }
    a {
      display: inline-block; padding: 0.6rem 1.2rem; border-radius: 8px;
      background: #f4f4f5; color: #0f0f10; text-decoration: none; font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <h1>404</h1>
    <p>${message}</p>
    <a href="/">${homeLabel}</a>
  </main>
</body>
</html>
`;
}

// ── _redirects ──────────────────────────────────────────────────────────────

function parseRedirects(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/);
      return { from, to, status: status ? Number(status) : 302 };
    });
}

export function buildRedirects(routes) {
  const width = Math.max(...routes.map((r) => r.length), 1) + 3;
  return `# Generado por safe-deploy. Solo las rutas de la app reciben index.html.
# El destino es "/" y NO "/index.html": Pages quita /index.html de las URLs, descarta
# las reglas con comodín como "bucle infinito" (404) y redirige (308) las exactas.
# No uses "/*": mandaría index.html (200) a los assets que ya no existen.

${routes.map((route) => `${route.padEnd(width)}/   200`).join('\n')}
`;
}

/** @returns {string[]} problemas encontrados en un _redirects existente */
export function lintRedirects(text, routes = []) {
  const problems = [];
  const rules = parseRedirects(text);
  for (const rule of rules) {
    if (rule.status === 200 && /\/index(\.html)?$/.test(rule.to ?? '')) {
      problems.push(
        `_redirects: "${rule.from} → ${rule.to} 200" no funciona en Cloudflare Pages ` +
          '(404 con comodín, 308 al inicio en rutas exactas). Usa "/" como destino.',
      );
    }
    if (rule.status === 200 && (rule.from === '/*' || rule.from === '*')) {
      problems.push(
        '_redirects: la regla "/*" entrega index.html (200) también a los assets que ya no existen ' +
          '→ error de MIME type tras un deploy. Lista solo las rutas de la app.',
      );
    }
  }
  const covered = (route) =>
    rules.some((r) => r.from === route || (r.from.endsWith('/*') && route.startsWith(r.from.slice(0, -1))));
  for (const route of routes) {
    if (!covered(route)) {
      problems.push(`_redirects: falta la ruta "${route}" (daría 404 al abrirla por URL o recargar).`);
    }
  }
  return problems;
}

// ── _headers ────────────────────────────────────────────────────────────────

function parseHeaders(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      if (!current) continue;
      const line = raw.trim();
      if (line.startsWith('!')) current.unset.push(line.slice(1).trim().toLowerCase());
      else {
        const idx = line.indexOf(':');
        if (idx > 0) current.set[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    } else {
      current = { pattern: raw.trim(), set: {}, unset: [] };
      blocks.push(current);
    }
  }
  return blocks;
}

export function buildHeaders({ assetPrefix = '/assets/', extraHeaders = {} } = {}) {
  const extra = Object.entries(extraHeaders)
    .map(([name, value]) => `  ${name}: ${value}\n`)
    .join('');
  return `# Generado por safe-deploy.
#
# Cloudflare COMBINA los headers de todas las reglas que coinciden (no gana la más
# específica). Por eso las reglas de abajo quitan con "! Header" lo heredado de /*.
#
# HTML y todo lo que no tiene hash: nunca se cachea → siempre apunta al build actual.
/*
${extra}  X-Content-Type-Options: nosniff
  Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
  CDN-Cache-Control: no-store
  Cloudflare-CDN-Cache-Control: no-store

# Assets con hash: inmutables 1 año.
# NO poner aquí CDN-Cache-Control / Cloudflare-CDN-Cache-Control: estas reglas también
# aplican a las respuestas 404, y con ellas el edge guarda 1 año el 404 de un asset
# pedido antes de terminar de propagarse el deploy.
${assetPrefix}*
  ! Cache-Control
  ! CDN-Cache-Control
  ! Cloudflare-CDN-Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`;
}

/** @returns {string[]} problemas encontrados en un _headers existente */
export function lintHeaders(text, assetPrefix = '/assets/') {
  const problems = [];
  const blocks = parseHeaders(text);
  const all = blocks.find((b) => b.pattern === '/*');
  const assets = blocks.filter((b) => b.pattern === `${assetPrefix}*`);
  const htmlNoStore = /no-store|no-cache/i.test(all?.set['cache-control'] ?? '');

  if (!htmlNoStore) {
    problems.push(
      '_headers: la regla "/*" no trae "Cache-Control: no-store". Si el HTML se cachea, tras un deploy ' +
        'el navegador sigue con un HTML viejo que pide assets que ya no existen.',
    );
  }
  for (const block of assets) {
    for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control']) {
      if (block.set[name]) {
        problems.push(
          `_headers: quita "${name}" de "${block.pattern}". También aplica a los 404, y el edge guarda ` +
            'durante ese tiempo el 404 de un asset pedido mientras el deploy se propaga.',
        );
      }
    }
    for (const name of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) {
      if (all?.set[name] && !block.unset.includes(name)) {
        problems.push(
          `_headers: "${block.pattern}" debe llevar "! ${name}" porque "/*" lo define y Cloudflare combina ` +
            'ambos valores (el asset heredaría no-store).',
        );
      }
    }
    if (!/immutable|max-age=\d{6,}/.test(block.set['cache-control'] ?? '')) {
      problems.push(`_headers: "${block.pattern}" no define un Cache-Control largo (immutable).`);
    }
  }
  if (htmlNoStore && assets.length === 0) {
    problems.push(
      `_headers: no hay regla para "${assetPrefix}*": los assets heredan no-store y nunca se cachean (sitio lento).`,
    );
  }
  return problems;
}

// ── Aplicar a la carpeta de salida ──────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} options.outDir
 * @param {string} [options.assetPrefix]  prefijo URL de los assets con hash (default "/assets/")
 * @param {string[]} [options.routes]     rutas de la app (SPA) que deben recibir index.html
 * @param {object} [options.notFound]     textos de la página 404 generada
 * @param {Record<string,string>} [options.extraHeaders] headers extra para "/*" si se genera _headers
 * @returns {Promise<{ generated: string[], problems: string[] }>}
 */
export async function applyCloudflarePages(options) {
  const { outDir, assetPrefix = '/assets/', routes = [], notFound, extraHeaders } = options;
  const generated = [];
  const problems = [];

  if ((await read(join(outDir, '404.html'))) === null) {
    await writeFile(join(outDir, '404.html'), build404Html(notFound), 'utf8');
    generated.push('404.html');
  }

  const redirects = await read(join(outDir, '_redirects'));
  if (redirects === null) {
    if (routes.length > 0) {
      await writeFile(join(outDir, '_redirects'), buildRedirects(routes), 'utf8');
      generated.push('_redirects');
    }
  } else {
    problems.push(...lintRedirects(redirects, routes));
  }

  const headers = await read(join(outDir, '_headers'));
  if (headers === null) {
    await writeFile(join(outDir, '_headers'), buildHeaders({ assetPrefix, extraHeaders }), 'utf8');
    generated.push('_headers');
  } else {
    problems.push(...lintHeaders(headers, assetPrefix));
  }

  const index = await read(join(outDir, 'index.html'));
  if (index !== null) {
    const guardAt = findGuardScript(index);
    const moduleAt = index.search(/<script[^>]+type=["']module["']/);
    if (guardAt === -1) {
      problems.push(`index.html no carga ${GUARD_FILE}: si el bundle principal falla, la página queda en blanco.`);
    } else if (moduleAt !== -1 && guardAt > moduleAt) {
      problems.push(`index.html: ${GUARD_FILE} debe ir ANTES del bundle (primer script del <head>).`);
    }
  }

  return { generated, problems };
}
