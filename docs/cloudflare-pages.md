# Cloudflare Pages: por qué falla un deploy y cómo lo evita safe-deploy

Todo lo de este documento se comprobó contra un sitio real en Cloudflare Pages (octubre 2026).

## El problema de fondo

Vite pone un hash en el nombre de cada archivo (`index-Dd9XrozJ.js`). Cada build genera nombres nuevos, y Cloudflare Pages **reemplaza el sitio completo** en cada deploy: los archivos del build anterior dejan de existir.

De ahí salen todos los errores:

1. Una pestaña abierta con el HTML viejo pide un chunk viejo → ya no existe.
2. Si el hosting responde `index.html` (200) a ese archivo inexistente, el navegador recibe HTML donde esperaba JS → `Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`.
3. Si responde 404 pero ese 404 se cachea, el archivo "sigue sin existir" aunque ya exista.

## Las reglas

### 1. Debe existir `404.html` en la raíz

Sin un `404.html`, Cloudflare Pages activa su **modo SPA**: responde `index.html` con status 200 a **cualquier** ruta inexistente, incluidos `/assets/*.js`. Con `404.html`, lo inexistente da un 404 real.

Efecto secundario: las rutas de la app dejan de funcionar por URL directa, y hay que declararlas en `_redirects`.

### 2. `_redirects`: solo las rutas de la app, con destino `/`

```
/producto/*   /   200
/contacto     /   200
```

- **El destino es `/`, no `/index.html`.** Pages quita `/index.html` de las URLs. Con ese destino, las reglas con comodín se descartan como "bucle infinito" (→ 404) y las exactas responden 308 hacia `/`.
- **No uses `/* / 200`.** Entrega `index.html` a los assets inexistentes: regresa el error de MIME.
- Cada ruta nueva de la app debe agregarse (o quedar cubierta por un comodín). Si falta, funciona al navegar dentro de la app pero da 404 al abrirla por URL o recargar.

### 3. `_headers`: HTML sin caché, assets inmutables, 404 sin caché

```
/*
  Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
  CDN-Cache-Control: no-store
  Cloudflare-CDN-Cache-Control: no-store

/assets/*
  ! Cache-Control
  ! CDN-Cache-Control
  ! Cloudflare-CDN-Cache-Control
  Cache-Control: public, max-age=31536000, immutable
```

- **Cloudflare combina los headers de todas las reglas que coinciden**; no gana la más específica. Por eso `/assets/*` quita con `! Header` lo heredado de `/*`. Sin eso, el asset queda con `no-store, ..., immutable` y nunca se cachea.
- **No pongas `CDN-Cache-Control` ni `Cloudflare-CDN-Cache-Control` en `/assets/*`.** Las reglas también aplican a las respuestas 404. Con esos headers, el edge guardó durante 1 año el 404 de un asset pedido mientras el deploy se propagaba. Con solo `Cache-Control`, los 200 se cachean igual y los 404 salen con `no-store`.
- Todo el HTML (no solo `/`) debe ir sin caché: las rutas de la app también entregan `index.html`.

### 4. Script de recuperación antes del bundle

`stale-asset-guard.js` es un script clásico que va como **primer script del `<head>`**. Si el bundle principal no carga, es lo único que corre. Cuando falla un `<script>` o `<link>` de `/assets/`:

1. Vuelve a pedir el archivo con `cache: 'reload'`. El navegador guarda el 404 de un asset unas 4 horas; esto lo reemplaza.
2. Si ya responde bien → recarga.
3. Si no → recarga una vez, por si el HTML era viejo.
4. Si sigue sin existir → muestra "Actualizando la página…" y reintenta cada 1.5 s (hasta ~90 s). Es el caso de un deploy propagándose.
5. Límite de 4 recargas cada 2 minutos; si se agotan, muestra un botón "Reintentar".

Los `import()` dinámicos (páginas con `lazy()`) no disparan ese evento: los cubre `installChunkRecovery()` de `safe-deploy/client`, que delega en el mismo script.

### 5. Conservar los assets de builds anteriores

El build descarga de producción los assets de los builds anteriores y los incluye en el nuevo. Así una pestaña abierta sigue funcionando con su versión hasta que recarga.

- `assets-manifest.json` registra cuándo se vio cada archivo; se conservan 30 días.
- Si producción aún no tiene manifest, se descubren siguiendo las referencias desde su `index.html`.
- Necesita internet y la URL de producción al compilar. Si falta, avisa y el build sigue sin esta protección.

## Checklist de deploy

1. `.env` con la API de producción y `VITE_SITE_URL` con el dominio de producción.
2. `npm run build`, con internet.
3. El log termina en `[safe-deploy] listo para desplegar dist/`, sin advertencias.
4. Subir `dist/` completo, sin volver a compilar con otro comando.
5. `npx safe-deploy check --site https://dominio --route <ruta> ...`

## Diagnóstico

| Síntoma | Causa probable | Solución |
|---|---|---|
| Error de MIME `text/html` en consola | Falta `404.html` o hay `/*` en `_redirects` | Regla 1 y 2 |
| Una ruta da 404 al abrirla por URL o recargar | No está en `_redirects` | Agrégala a `routes` |
| Las rutas con comodín dan 404 y las exactas redirigen al inicio | Destino `/index.html` | Usa `/` |
| Un asset da 404 durante horas aunque existe | 404 en caché | Regla 3; verifica que el guard sea el actual |
| Sitio lento, los JS no salen "from disk cache" | `/assets/*` hereda `no-store` | Faltan los `! Header` |
| Se queda en "Actualizando la página…" | El asset no existe en el deploy | Recompila y sube `dist/` completo |
| Pestañas abiertas fallan tras un deploy | El build no traía assets anteriores | Revisa `VITE_SITE_URL` y el log |
| `404` en consola justo después de desplegar, y luego carga | Propagación del deploy | Esperado; no hay nada que corregir |
