---
name: safe-deploy
description: Prepara, revisa y verifica deploys de sitios estáticos (Vite/React, Ionic, Astro, SPA) en Cloudflare Pages para que una actualización nunca rompa la página a quien la tiene abierta. Úsala al crear o configurar un proyecto que se sube a Cloudflare Pages, al agregar rutas, antes de un deploy ("voy a subir el build", "prepara el deploy"), después de un deploy para verificarlo, o ante errores como pantalla en blanco tras desplegar, "MIME type text/html", 404 en /assets, o rutas que dan 404 al recargar.
---

# safe-deploy

Paquete: `github:luislopez-labs/safe-deploy`. Lee su `docs/cloudflare-pages.md` (en `node_modules/safe-deploy/docs/`) cuando necesites el porqué de una regla o diagnosticar un error.

El objetivo es uno: **que un deploy nunca deje a un cliente con la página rota**. No des un deploy por bueno sin haber corrido la verificación del final.

## 1. Detecta el caso

- ¿El proyecto se sube a Cloudflare Pages? Si es Netlify, Vercel o un VPS, dilo: el paquete solo aporta el script de recuperación y los assets anteriores (`host: 'none'`); la configuración del hosting es distinta. Next.js queda fuera.
- ¿Ya tiene `safe-deploy` en `package.json`? Si no, instálalo (paso 2). Si sí, ve al paso que pidan.
- ¿Tiene una solución manual previa (`public/stale-asset-guard.js`, `scripts/carry-over-assets.mjs`, listeners de chunks en `main.tsx`)? Entonces es una migración: paso 3.

## 2. Instalar en un proyecto Vite

1. `npm i -D github:luislopez-labs/safe-deploy#v1.1.0` (usa el tag más reciente del repositorio: `git ls-remote --tags https://github.com/luislopez-labs/safe-deploy`).
2. En `vite.config`: `import { safeDeploy } from 'safe-deploy/vite'` y agrégalo a `plugins` con `routes`.
3. **`routes`**: lee el router del proyecto (`createBrowserRouter`, `<Route>`, `routes/`) y lista todas las rutas. Convierte los parámetros en comodín: `/rifa/:id` y `/rifa/:id/cuentas` → `/rifa/*`. No incluyas `/`. Nunca uses `/*`.
4. En el archivo de entrada (`main.tsx`): `import { installChunkRecovery } from 'safe-deploy/client'` y llama `installChunkRecovery()` antes de montar la app.
5. En `.env` y `.env.example`: `VITE_SITE_URL=<dominio de producción>`. Pregunta el dominio si no lo sabes; no lo inventes.
6. Si el proyecto necesita headers de seguridad (CSP, HSTS), pásalos en la opción `headers`, o deja su `public/_headers` y corrige lo que el build señale.
7. Compila y revisa el log (paso 4).

Sin Vite (Astro u otro): después del build corre `npx safe-deploy prepare --dir <salida> --assets <carpeta de assets> --site <url> --route <ruta>` y agrega `<script src="/stale-asset-guard.js"></script>` como primer script del `<head>`.

## 3. Migrar una solución manual

Quita lo que el paquete ya hace, para no tener dos versiones:

- `public/stale-asset-guard.js` y su `<script>` en `index.html` (el plugin lo inserta).
- `scripts/carry-over-assets.mjs` y su llamada en `postbuild`.
- Los listeners de `vite:preloadError` / `unhandledrejection` / `error` en `main.tsx` → `installChunkRecovery()`.

Conserva `public/_headers`, `public/_redirects` y `public/404.html` si tienen contenido propio del proyecto (CSP, textos): el plugin los revisa en vez de generarlos. Conserva cualquier otro script de `postbuild` del proyecto.

Después compila y compara: el nuevo `dist/` debe tener los mismos archivos de control que antes.

## 4. Antes de cada deploy

1. `.env`: la API apunta a producción (no `localhost`) y `VITE_SITE_URL` es el dominio real.
2. Si se agregaron rutas, están en `routes` (o en `public/_redirects`).
3. Compila con el script de build del proyecto (`npm run build`), con internet. No uses `vite build` suelto si el proyecto tiene `postbuild`.
4. El log debe terminar con `[safe-deploy] assets: N del build actual + M de builds anteriores (...)` y `[safe-deploy] listo para desplegar`. Cualquier línea `[safe-deploy] ⚠️` es un problema: corrígelo y vuelve a compilar. `M` es 0 solo en el primer deploy del proyecto.
5. No vuelvas a compilar con otro comando entre el build y la subida: se pierde el `postbuild`.

No despliegues tú salvo que te lo pidan; lo habitual es que la persona suba `dist/`.

## 5. Después de cada deploy

Corre y muestra el resultado completo:

```
npx safe-deploy check --site <dominio> --route <ruta> --route <ruta>
```

- Incluye al menos una ruta por cada patrón de `routes` (una dinámica real y una estática).
- En Git Bash las rutas van sin `/` inicial (`--route rifa/abc`); en PowerShell, normales.
- Cada `✗` es un fallo real: explícalo con la tabla de diagnóstico de `docs/cloudflare-pages.md` y corrígelo. Un `!` es una advertencia: explícala.
- "Manifest con un solo build" es normal solo en el primer deploy.

## 6. Qué decirle a la persona

- Durante los segundos de propagación, quien entre por primera vez puede ver "Actualizando la página…" un momento y queda un `404` en la consola. Es esperado; no es un error que haya que corregir.
- Lo demás no debe pasar. Si alguien reporta pantalla en blanco o un error tras un deploy, pide el nombre del archivo que falló (pestaña Red) y corre `check`.

## Reglas que no se rompen

- Nunca `/* / 200` en `_redirects`, ni `/index.html` como destino.
- Nunca `CDN-Cache-Control` ni `Cloudflare-CDN-Cache-Control` en `/assets/*`.
- Nunca borrar `404.html`.
- El guard siempre es el primer script del `<head>`.
