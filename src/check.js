// Verificación de un sitio YA desplegado: comprueba desde fuera que el deploy quedó
// protegido. Es lo que hay que correr después de cada deploy.

import { MANIFEST_FILE } from './carry-over.js';
import { GUARD_FILE } from './guard.js';

/**
 * @param {object} options
 * @param {string} options.siteUrl
 * @param {string[]} [options.routes]      rutas de la app a comprobar (deben dar 200)
 * @param {string} [options.assetPrefix]   default "/assets/"
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{ ok: boolean, results: { level: 'ok'|'warn'|'fail', message: string }[] }>}
 */
export async function checkDeployment(options) {
  const { assetPrefix = '/assets/', fetch: fetchImpl = globalThis.fetch } = options;
  const routes = (options.routes ?? []).map((r) => (r.startsWith('/') ? r : `/${r}`));
  const siteUrl = options.siteUrl.trim().replace(/\/+$/, '');
  const results = [];
  const add = (level, message) => results.push({ level, message });
  // Un fallo de red no aborta la verificación: cuenta como respuesta con status 0.
  const get = (path) =>
    fetchImpl(`${siteUrl}${path}`, { redirect: 'manual', cache: 'no-store' }).catch(
      (err) => new Response(null, { status: 599, statusText: err.cause?.code || err.message }),
    );
  const header = (res, name) => res.headers.get(name) || '';

  // 1. HTML
  const home = await get('/');
  const html = home.status === 200 ? await home.text() : '';
  if (home.status === 599) {
    add('fail', `No se pudo conectar con ${siteUrl} (${home.statusText})`);
    return { ok: false, results };
  }
  if (home.status !== 200) add('fail', `/ respondió ${home.status}`);
  else if (!/no-store|no-cache/i.test(header(home, 'cache-control'))) {
    add('fail', `El HTML se puede cachear (Cache-Control: "${header(home, 'cache-control')}"). Debe ser no-store.`);
  } else add('ok', 'El HTML no se cachea');

  // 2. Guard
  const guardAt = html.indexOf(GUARD_FILE);
  const moduleAt = html.search(/<script[^>]+type=["']module["']/);
  if (guardAt === -1) add('fail', `index.html no carga ${GUARD_FILE}`);
  else if (moduleAt !== -1 && guardAt > moduleAt) add('fail', `${GUARD_FILE} está después del bundle`);
  else {
    const guard = await get(`/${GUARD_FILE}`);
    const body = guard.status === 200 ? await guard.text() : '';
    if (!body.includes('__recoverStaleAsset')) add('fail', `${GUARD_FILE} no es la versión actual (o no existe)`);
    else add('ok', 'Script de recuperación presente y antes del bundle');
  }

  // 3. Assets del HTML
  const escaped = assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assets = [...new Set([...html.matchAll(new RegExp(`["'](${escaped}[^"']+)["']`, 'g'))].map((m) => m[1]))];
  if (assets.length === 0) add('warn', `index.html no referencia ningún archivo en ${assetPrefix}`);
  let assetsOk = true;
  for (const asset of assets) {
    const res = await get(asset);
    const type = header(res, 'content-type');
    if (res.status !== 200 || type.includes('text/html')) {
      assetsOk = false;
      add('fail', `${asset} respondió ${res.status} (${type})`);
    } else if (!/immutable|max-age=\d{6,}/.test(header(res, 'cache-control'))) {
      assetsOk = false;
      add('warn', `${asset} no se cachea a largo plazo (Cache-Control: "${header(res, 'cache-control')}")`);
    }
  }
  if (assets.length && assetsOk) add('ok', `${assets.length} assets del HTML responden 200 y se cachean`);

  // 4. Asset inexistente: 404 real y sin caché
  const missing = `${assetPrefix}__safe-deploy-check-${Date.now().toString(36)}.js`;
  const first = await get(missing);
  if (first.status === 200) {
    add('fail', 'Un asset inexistente responde 200 (modo SPA activo o regla "/*"): provoca el error de MIME type');
  } else {
    await new Promise((r) => setTimeout(r, 1500));
    const second = await get(missing);
    const cacheControl = header(second, 'cache-control');
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
    if (/^HIT$/i.test(header(second, 'cf-cache-status'))) {
      add('fail', 'El CDN está cacheando el 404 de un asset inexistente (cf-cache-status: HIT)');
    } else if (maxAge > 300 && !/no-store/i.test(cacheControl)) {
      add('warn', `El navegador guardará el 404 de un asset ${maxAge}s (Cache-Control: "${cacheControl}")`);
    } else add('ok', `Asset inexistente → ${second.status} sin caché`);
  }

  // 5. Manifest de assets anteriores
  const manifestRes = await get(`/${MANIFEST_FILE}`);
  if (manifestRes.status !== 200 || header(manifestRes, 'content-type').includes('text/html')) {
    add('fail', `Falta /${MANIFEST_FILE}: el build no conservó los assets anteriores`);
  } else {
    const manifest = await manifestRes.json();
    const dates = new Set(Object.values(manifest));
    add(
      dates.size > 1 ? 'ok' : 'warn',
      dates.size > 1
        ? `Manifest con ${Object.keys(manifest).length} assets de ${dates.size} builds`
        : `Manifest con un solo build (${Object.keys(manifest).length} assets): normal solo en el primer deploy`,
    );
  }

  // 6. Rutas de la app
  for (const route of routes) {
    const res = await get(route);
    if (res.status === 200 && header(res, 'content-type').includes('text/html')) add('ok', `${route} → 200`);
    else add('fail', `${route} respondió ${res.status}${header(res, 'location') ? ` → ${header(res, 'location')}` : ''}`);
  }

  return { ok: !results.some((r) => r.level === 'fail'), results };
}
