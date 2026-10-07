// Plugin de Vite: aplica todo safe-deploy en `vite build`.
//
//   import { safeDeploy } from 'safe-deploy/vite'
//   plugins: [react(), safeDeploy({ routes: ['/producto/*', '/contacto'] })]

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEnv } from 'vite';
import { applyCloudflarePages } from './cloudflare.js';
import { carryOverAssets } from './carry-over.js';
import { buildGuardScript, findGuardScript, GUARD_FILE } from './guard.js';

const TAG = '[safe-deploy]';

export function safeDeploy(options = {}) {
  const host = options.host ?? 'cloudflare-pages';
  let config;
  let assetPrefix = '/assets/';

  return {
    name: 'safe-deploy',
    apply: 'build',
    enforce: 'post',

    configResolved(resolved) {
      config = resolved;
      const base = resolved.base.startsWith('/') ? resolved.base : '/';
      assetPrefix = `${base}${resolved.build.assetsDir.replace(/^\/+|\/+$/g, '')}/`;
    },

    // El guard debe ser el PRIMER script: si el bundle principal no carga, es lo único que corre.
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (findGuardScript(html) !== -1) return html;
        const base = config.base.startsWith('/') ? config.base : '/';
        return [{ tag: 'script', attrs: { src: `${base}${GUARD_FILE}` }, injectTo: 'head-prepend' }];
      },
    },

    async closeBundle() {
      if (config.build.ssr) return;
      const log = config.logger;
      const outDir = resolve(config.root, config.build.outDir);
      const problems = [];

      await writeFile(
        join(outDir, GUARD_FILE),
        buildGuardScript({ assetPrefixes: [assetPrefix], texts: options.texts }),
        'utf8',
      );

      if (host === 'cloudflare-pages') {
        const applied = await applyCloudflarePages({
          outDir,
          assetPrefix,
          routes: options.routes,
          notFound: options.notFound,
          extraHeaders: options.headers,
        });
        if (applied.generated.length) log.info(`${TAG} generados: ${applied.generated.join(', ')}`);
        problems.push(...applied.problems);
      } else if (host !== 'none') {
        problems.push(`host "${host}" aún no está soportado: solo se generó ${GUARD_FILE} y los assets anteriores.`);
      }

      if (options.carryOver !== false) {
        const env = loadEnv(config.mode, config.envDir || config.root, '');
        const siteUrl =
          options.siteUrl ??
          process.env.SAFE_DEPLOY_SITE_URL ??
          process.env.VITE_SITE_URL ??
          env.SAFE_DEPLOY_SITE_URL ??
          env.VITE_SITE_URL;
        const carried = await carryOverAssets({
          outDir,
          assetsDir: config.build.assetsDir,
          siteUrl,
          retentionDays: options.retentionDays,
        });
        if (carried.warning) problems.push(carried.warning);
        else {
          log.info(
            `${TAG} assets: ${carried.current} del build actual + ${carried.carried} de builds anteriores (${carried.siteUrl})`,
          );
        }
      }

      for (const problem of problems) log.warn(`${TAG} ⚠️  ${problem}`);
      if (problems.length && options.strict) {
        throw new Error(`${TAG} ${problems.length} problema(s) con strict: true. Corrígelos antes de desplegar.`);
      }
      if (!problems.length) log.info(`${TAG} listo para desplegar ${config.build.outDir}/`);
    },
  };
}

export default safeDeploy;
