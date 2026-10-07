#!/usr/bin/env node
// CLI de safe-deploy. Para proyectos sin Vite (o para verificar un deploy).

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applyCloudflarePages, buildGuardScript, carryOverAssets, checkDeployment, GUARD_FILE } from '../src/index.js';

const HELP = `safe-deploy <comando> [opciones]

  check     Verifica un sitio ya desplegado
              --site <url>            (o env SAFE_DEPLOY_SITE_URL / VITE_SITE_URL)
              --route <ruta>          ruta de la app que debe dar 200 (repetible).
                                      En Git Bash escríbela sin "/" inicial: --route producto/1
              --assets <dir>          carpeta de assets con hash (default: assets)

  prepare   Prepara una carpeta de salida que no generó el plugin de Vite
              --dir <carpeta>         carpeta de salida (default: dist)
              --site <url>            sitio en producción, para conservar assets anteriores
              --route <ruta>          ruta de la app (repetible)
              --assets <dir>          carpeta de assets con hash (default: assets)
              --host <host>           cloudflare-pages (default) | none
              --retention <días>      default: 30

Con "prepare" el <script src="/${GUARD_FILE}"> debe estar a mano como primer script del <head>.
`;

function parseArgs(argv) {
  const args = { _: [], route: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) args._.push(arg);
    else if (arg === '--route') args.route.push(argv[++i]);
    else args[arg.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Git Bash en Windows convierte "/ruta" en "C:/Program Files/Git/ruta" antes de que llegue aquí.
const mangled = args.route.find((r) => /^[A-Za-z]:[\\/]/.test(r ?? ''));
if (mangled) {
  console.error(
    `La ruta llegó como "${mangled}": Git Bash la convirtió en una ruta de Windows.\n` +
      'Escríbela sin la diagonal inicial (--route producto/1) o usa PowerShell.',
  );
  process.exit(2);
}
const command = args._[0];
const siteUrl = args.site || process.env.SAFE_DEPLOY_SITE_URL || process.env.VITE_SITE_URL || '';
const assetsDir = typeof args.assets === 'string' ? args.assets.replace(/^\/+|\/+$/g, '') : 'assets';
const assetPrefix = `/${assetsDir}/`;

if (command === 'check') {
  if (!siteUrl) {
    console.error('Falta --site <url>');
    process.exit(2);
  }
  const { ok, results } = await checkDeployment({ siteUrl, routes: args.route, assetPrefix });
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of results) console.log(` ${icon[r.level]} ${r.message}`);
  console.log(ok ? `\n${siteUrl}: deploy correcto` : `\n${siteUrl}: HAY PROBLEMAS (✗)`);
  process.exit(ok ? 0 : 1);
} else if (command === 'prepare') {
  const outDir = resolve(typeof args.dir === 'string' ? args.dir : 'dist');
  const problems = [];
  await writeFile(join(outDir, GUARD_FILE), buildGuardScript({ assetPrefixes: [assetPrefix] }), 'utf8');
  if ((args.host ?? 'cloudflare-pages') === 'cloudflare-pages') {
    const applied = await applyCloudflarePages({ outDir, assetPrefix, routes: args.route });
    if (applied.generated.length) console.log(`generados: ${applied.generated.join(', ')}`);
    problems.push(...applied.problems);
  }
  const carried = await carryOverAssets({
    outDir,
    assetsDir,
    siteUrl,
    retentionDays: args.retention ? Number(args.retention) : undefined,
  });
  if (carried.warning) problems.push(carried.warning);
  else console.log(`assets: ${carried.current} del build actual + ${carried.carried} de builds anteriores (${carried.siteUrl})`);
  for (const p of problems) console.warn(`⚠️  ${p}`);
  process.exit(problems.length && args.strict ? 1 : 0);
} else {
  console.log(HELP);
  process.exit(command ? 2 : 0);
}
