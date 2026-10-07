import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  applyCloudflarePages,
  buildGuardScript,
  buildHeaders,
  buildRedirects,
  carryOverAssets,
  checkDeployment,
  findGuardScript,
  lintHeaders,
  lintRedirects,
} from '../src/index.js';

const tmp = () => mkdtemp(join(tmpdir(), 'safe-deploy-'));

/** Servidor que imita un sitio estático desplegado. `files`: ruta → [status, tipo, cuerpo, headers]. */
async function serve(files) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const hit = files[path];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end('<h1>404</h1>');
    }
    const [status, type, body, headers = {}] = hit;
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('lintRedirects detecta /index.html, "/*" y rutas faltantes', () => {
  const bad = '/rifa/*  /index.html  200\n/nosotros  /index.html  200\n/*  /  200\n';
  const problems = lintRedirects(bad, ['/contacto']);
  assert.equal(problems.filter((p) => p.includes('/index.html')).length, 2);
  assert.ok(problems.some((p) => p.includes('"/*"')));
  assert.deepEqual(lintRedirects(buildRedirects(['/rifa/*', '/nosotros']), ['/rifa/abc/cuentas', '/nosotros']), []);
  assert.ok(lintRedirects('/a / 200', ['/b']).some((p) => p.includes('"/b"')));
});

test('lintHeaders: el archivo generado pasa; los errores conocidos se detectan', () => {
  assert.deepEqual(lintHeaders(buildHeaders()), []);

  const cdnOnAssets = buildHeaders().replace(
    'Cache-Control: public, max-age=31536000, immutable',
    'Cache-Control: public, max-age=31536000, immutable\n  CDN-Cache-Control: public, max-age=31536000',
  );
  assert.ok(lintHeaders(cdnOnAssets).some((p) => p.includes('cdn-cache-control') && p.includes('404')));

  const noUnset = '/*\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n';
  assert.ok(lintHeaders(noUnset).some((p) => p.includes('! cache-control')));

  assert.ok(lintHeaders('/*\n  X-Frame-Options: DENY\n').some((p) => p.includes('no-store')));
  assert.ok(lintHeaders('/*\n  Cache-Control: no-store\n').some((p) => p.includes('heredan no-store')));
});

test('applyCloudflarePages genera lo que falta y respeta lo que existe', async () => {
  const outDir = await tmp();
  await writeFile(join(outDir, 'index.html'), '<head><script src="/stale-asset-guard.js"></script><script type="module" src="/assets/a.js"></script></head>');
  const first = await applyCloudflarePages({ outDir, routes: ['/p/*'] });
  assert.deepEqual(first.generated.sort(), ['404.html', '_headers', '_redirects']);
  assert.deepEqual(first.problems, []);
  assert.match(await readFile(join(outDir, '_redirects'), 'utf8'), /\/p\/\*\s+\/\s+200/);

  await writeFile(join(outDir, '_redirects'), '/p/* /index.html 200\n');
  const second = await applyCloudflarePages({ outDir, routes: ['/p/*'] });
  assert.deepEqual(second.generated, []);
  assert.equal(second.problems.length, 1);
  assert.equal(await readFile(join(outDir, '_redirects'), 'utf8'), '/p/* /index.html 200\n');
});

test('applyCloudflarePages avisa si falta el guard o va después del bundle', async () => {
  const outDir = await tmp();
  await writeFile(join(outDir, 'index.html'), '<head><script type="module" src="/assets/a.js"></script></head>');
  assert.ok((await applyCloudflarePages({ outDir })).problems.some((p) => p.includes('no carga')));
  await writeFile(join(outDir, 'index.html'), '<head><script type="module" src="/assets/a.js"></script><script src="/stale-asset-guard.js"></script></head>');
  assert.ok((await applyCloudflarePages({ outDir })).problems.some((p) => p.includes('ANTES')));
});

test('buildGuardScript produce JS válido que expone __recoverStaleAsset', () => {
  const code = buildGuardScript({ assetPrefixes: ['/static/'], texts: { retry: 'Otra vez' } });
  const listeners = {};
  const window = { addEventListener: (name, fn) => (listeners[name] = fn), location: { origin: 'https://x.test', href: 'https://x.test/' } };
  vm.runInNewContext(code, { window, document: {}, sessionStorage: {}, fetch: () => {}, URL, setTimeout });
  assert.equal(typeof window.__recoverStaleAsset, 'function');
  assert.equal(typeof listeners.error, 'function');
  assert.ok(code.includes('/static/') && code.includes('Otra vez'));
});

test('carryOverAssets: sin manifest descubre los assets siguiendo el index.html', async () => {
  const site = await serve({
    '/': [200, 'text/html', '<script type="module" src="/assets/index-OLD.js"></script><link href="/assets/index-OLD.css">'],
    '/assets/index-OLD.js': [200, 'text/javascript', 'import("./Page-OLD.js"); const d=["assets/Shared-KEEP.js","assets/nope-404.js"]'],
    '/assets/index-OLD.css': [200, 'text/css', 'body{}'],
    '/assets/Page-OLD.js': [200, 'text/javascript', 'export default 1'],
    '/assets/Shared-KEEP.js': [200, 'text/javascript', 'old-copy'],
  });
  const outDir = await tmp();
  await mkdir(join(outDir, 'assets'));
  await writeFile(join(outDir, 'assets', 'index-NEW.js'), 'new');
  await writeFile(join(outDir, 'assets', 'Shared-KEEP.js'), 'new-copy');

  const result = await carryOverAssets({ outDir, siteUrl: site.url });
  site.close();
  assert.equal(result.warning, undefined);
  assert.equal(result.current, 2);
  assert.equal(result.carried, 3);
  assert.deepEqual((await readdir(join(outDir, 'assets'))).sort(), ['Page-OLD.js', 'Shared-KEEP.js', 'index-NEW.js', 'index-OLD.css', 'index-OLD.js']);
  // Un archivo del build actual nunca se pisa con la copia de producción.
  assert.equal(await readFile(join(outDir, 'assets', 'Shared-KEEP.js'), 'utf8'), 'new-copy');
  assert.equal(Object.keys(JSON.parse(await readFile(join(outDir, 'assets-manifest.json'), 'utf8'))).length, 5);
});

test('carryOverAssets: con manifest respeta la retención y no sale de la carpeta', async () => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const site = await serve({
    '/assets-manifest.json': [200, 'application/json', JSON.stringify({ 'a-RECENT.js': recent, 'b-EXPIRED.js': old, '../evil.js': recent })],
    '/assets/a-RECENT.js': [200, 'text/javascript', 'a'],
    '/assets/b-EXPIRED.js': [200, 'text/javascript', 'b'],
  });
  const outDir = await tmp();
  await mkdir(join(outDir, 'assets'));
  await writeFile(join(outDir, 'assets', 'c-NEW.js'), 'c');
  const result = await carryOverAssets({ outDir, siteUrl: site.url });
  site.close();
  assert.equal(result.carried, 1);
  assert.deepEqual((await readdir(join(outDir, 'assets'))).sort(), ['a-RECENT.js', 'c-NEW.js']);
  const manifest = JSON.parse(await readFile(join(outDir, 'assets-manifest.json'), 'utf8'));
  assert.equal(manifest['a-RECENT.js'], recent); // conserva la fecha original para que caduque
});

test('carryOverAssets: sin URL o sin red avisa pero no falla y escribe el manifest', async () => {
  const outDir = await tmp();
  await mkdir(join(outDir, 'assets'));
  await writeFile(join(outDir, 'assets', 'x.js'), 'x');
  assert.match((await carryOverAssets({ outDir })).warning, /Falta la URL/);
  const offline = await carryOverAssets({ outDir, siteUrl: 'http://127.0.0.1:9' });
  assert.match(offline.warning, /No se pudieron conservar/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(outDir, 'assets-manifest.json'), 'utf8'))), ['x.js']);
});

test('checkDeployment: sitio correcto pasa; SPA fallback y ruta rota fallan', async () => {
  const immutable = { 'cache-control': 'public, max-age=31536000, immutable' };
  const html = '<head><script src="/stale-asset-guard.js"></script><script type="module" src="/assets/index-A.js"></script></head>';
  const good = {
    '/': [200, 'text/html', html, { 'cache-control': 'no-store' }],
    '/producto/1': [200, 'text/html', html, { 'cache-control': 'no-store' }],
    '/stale-asset-guard.js': [200, 'text/javascript', buildGuardScript()],
    '/assets/index-A.js': [200, 'text/javascript', 'x', immutable],
    '/assets-manifest.json': [200, 'application/json', JSON.stringify({ 'index-A.js': '2026-01-02', 'index-0.js': '2026-01-01' })],
  };
  const site = await serve(good);
  const ok = await checkDeployment({ siteUrl: site.url, routes: ['/producto/1'] });
  assert.equal(ok.ok, true, JSON.stringify(ok.results));
  const broken = await checkDeployment({ siteUrl: site.url, routes: ['/no-registrada'] });
  site.close();
  assert.equal(broken.ok, false);
  assert.ok(broken.results.some((r) => r.level === 'fail' && r.message.includes('/no-registrada')));

  const cached = await serve({ ...good, '/': [200, 'text/html', html, { 'cache-control': 'max-age=600' }] });
  const res = await checkDeployment({ siteUrl: cached.url });
  cached.close();
  assert.ok(res.results.some((r) => r.level === 'fail' && r.message.includes('HTML se puede cachear')));
});

test('findGuardScript ignora menciones en comentarios y texto', async () => {
  const comment = '<head><!-- el build inserta /stale-asset-guard.js aquí --><script type="module" src="/assets/a.js"></script></head>';
  assert.equal(findGuardScript(comment), -1);
  assert.equal(findGuardScript('<p>stale-asset-guard.js</p>'), -1);
  assert.ok(findGuardScript('<head><script src="/stale-asset-guard.js"></script></head>') > 0);
  assert.ok(findGuardScript("<script defer src='/base/stale-asset-guard.js?v=2'></script>") === 0);

  const outDir = await tmp();
  await writeFile(join(outDir, 'index.html'), comment);
  assert.ok((await applyCloudflarePages({ outDir })).problems.some((p) => p.includes('no carga')));
});
