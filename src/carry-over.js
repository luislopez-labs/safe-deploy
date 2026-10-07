// Conserva en la carpeta de salida los assets con hash de los builds ANTERIORES.
//
// Un hosting estático reemplaza el sitio completo en cada deploy: los assets con hash
// del build anterior dejan de existir. Quien tenga la página abierta en ese momento
// pide un chunk viejo al navegar (carga diferida) y recibe un 404. Para que eso no
// pase, cada build se lleva consigo los assets de los anteriores, descargándolos del
// sitio en producción.
//
// <outDir>/assets-manifest.json guarda cuándo se vio por primera vez cada archivo; los
// que pasan de `retentionDays` dejan de copiarse. Si producción aún no tiene manifest
// (primer build con safe-deploy), los assets se descubren siguiendo las referencias
// desde su index.html.
//
// Nunca lanza por problemas de red: devuelve `warning` y el build sigue.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

export const MANIFEST_FILE = 'assets-manifest.json';

const CONCURRENCY = 8;
const SAFE_NAME = /^(?!.*\.\.)[\w.\-/]+\.[a-z0-9]+$/i;
const CRAWL_EXTENSIONS = 'js|mjs|css|woff2?|ttf|png|jpe?g|webp|avif|gif|svg|json|wasm';

async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

/**
 * @param {object} options
 * @param {string} options.outDir        carpeta de salida del build (p. ej. "dist")
 * @param {string} [options.assetsDir]   subcarpeta de assets con hash (default "assets")
 * @param {string} [options.siteUrl]     URL del sitio en producción
 * @param {number} [options.retentionDays] días que se conservan los assets viejos (default 30)
 * @param {typeof fetch} [options.fetch] para pruebas
 * @returns {Promise<{ current: number, carried: number, siteUrl: string, warning?: string }>}
 */
export async function carryOverAssets(options) {
  const {
    outDir,
    assetsDir = 'assets',
    retentionDays = 30,
    fetch: fetchImpl = globalThis.fetch,
  } = options;
  const siteUrl = (options.siteUrl || '').trim().replace(/\/+$/, '');
  const assetsPath = join(outDir, assetsDir);
  const assetsUrl = `/${assetsDir.replace(/^\/+|\/+$/g, '')}`;

  const now = new Date().toISOString();
  const current = await listFiles(assetsPath);
  const manifest = Object.fromEntries(current.map((name) => [name, now]));
  const result = { current: current.length, carried: 0, siteUrl };

  const get = async (path) => {
    const res = await fetchImpl(`${siteUrl}${path}`, { cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    return { ok: res.ok, isHtml: type.includes('text/html'), res };
  };

  const listPrevious = async () => {
    const { ok, isHtml, res } = await get(`/${MANIFEST_FILE}`);
    if (ok && !isHtml) {
      const previous = await res.json();
      const limit = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      return Object.entries(previous).filter(
        ([name, seen]) => SAFE_NAME.test(name) && Date.parse(seen) >= limit,
      );
    }

    // Sin manifest: seguir las referencias desde el index.html publicado.
    const index = await get('/');
    if (!index.ok) throw new Error(`${siteUrl}/ respondió ${index.res.status}`);
    const found = new Set();
    const queue = [];
    const dirName = posix.basename(assetsUrl);
    const pattern = new RegExp(`(?:${dirName}/|\\./)([\\w.-]+\\.(?:${CRAWL_EXTENSIONS}))`, 'g');
    const collect = (text) => {
      for (const m of text.matchAll(pattern)) {
        if (!found.has(m[1])) {
          found.add(m[1]);
          queue.push(m[1]);
        }
      }
    };
    collect(await index.res.text());
    while (queue.length) {
      await inBatches(queue.splice(0, queue.length), async (name) => {
        const file = await get(`${assetsUrl}/${name}`);
        if (!file.ok || file.isHtml) {
          found.delete(name); // referencia que no es un asset real
          return;
        }
        if (/\.(m?js|css)$/.test(name)) collect(await file.res.text());
      });
    }
    return [...found].map((name) => [name, now]);
  };

  if (!siteUrl) {
    result.warning =
      'Falta la URL del sitio en producción (siteUrl / VITE_SITE_URL): no se conservan los assets del build anterior. ' +
      'Quien tenga la página abierta durante el deploy puede ver errores al navegar.';
  } else {
    try {
      const previous = (await listPrevious()).filter(([name]) => !current.includes(name));
      await inBatches(previous, async ([name, seen]) => {
        const { ok, isHtml, res } = await get(`${assetsUrl}/${name}`);
        if (!ok || isHtml) return;
        const target = join(assetsPath, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(await res.arrayBuffer()));
        manifest[name] = seen;
        result.carried += 1;
      });
    } catch (err) {
      result.warning = `No se pudieron conservar los assets anteriores de ${siteUrl}: ${err.message}`;
    }
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return result;
}
