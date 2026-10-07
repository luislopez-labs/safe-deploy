# safe-deploy

Deploys de sitios estáticos (Vite / SPA) que **no rompen la página a quien la tiene abierta**. Pensado para Cloudflare Pages.

Evita los tres problemas típicos después de subir un build nuevo:

| Problema | Qué ve el cliente | Cómo lo evita |
|---|---|---|
| Pestaña abierta pide un chunk del build anterior | Pantalla en blanco o error al navegar | Cada build conserva los assets de los anteriores (30 días) |
| El hosting responde `index.html` a un asset que ya no existe | `Expected a JavaScript module script but the server responded with a MIME type of "text/html"` | `404.html` real, `_redirects` solo con las rutas de la app |
| El 404 de un asset queda en caché (navegador o CDN) | Sigue fallando aunque recargue | Headers correctos + script que vuelve a pedir el asset y espera a que exista |

## Instalación

```bash
npm i -D github:luislopez-labs/safe-deploy#v1.0.0
```

## Uso con Vite

**1. `vite.config.ts`**

```ts
import { safeDeploy } from 'safe-deploy/vite'

export default defineConfig({
  plugins: [
    react(),
    safeDeploy({
      // Rutas de la app que deben abrir por URL directa. "/" no hace falta.
      routes: ['/producto/*', '/contacto', '/nosotros'],
    }),
  ],
})
```

**2. `.env`** — el dominio de producción, de donde se descargan los assets anteriores:

```
VITE_SITE_URL=https://midominio.com
```

**3. Entrada de la app (`main.tsx`)** — recuperación de páginas con `lazy()`:

```ts
import { installChunkRecovery } from 'safe-deploy/client'

installChunkRecovery()
```

**4. Compilar y subir**

```bash
npm run build      # con internet
```

El final del log debe decir:

```
[safe-deploy] assets: 23 del build actual + 16 de builds anteriores (https://midominio.com)
[safe-deploy] listo para desplegar dist/
```

Si aparece `[safe-deploy] ⚠️ ...`, léelo y corrígelo antes de subir `dist/`.

**5. Verificar después del deploy**

```bash
npx safe-deploy check --site https://midominio.com --route producto/1 --route contacto
```

> En Git Bash escribe las rutas sin la `/` inicial (Git Bash la convierte en una ruta de Windows).

## Qué hace el plugin en cada build

- Inserta `<script src="/stale-asset-guard.js">` como **primer script** del `<head>` y genera ese archivo.
- Genera `404.html`, `_redirects` y `_headers` **si el proyecto no los trae** en `public/`. Si ya existen no los toca: los revisa y avisa de los errores conocidos.
- Descarga de producción los assets de builds anteriores y escribe `assets-manifest.json`.
- Avisa (o falla, con `strict: true`) si algo quedó mal.

## Opciones

| Opción | Default | Descripción |
|---|---|---|
| `routes` | `[]` | Rutas de la app. Usa comodín para las dinámicas (`/producto/*`). |
| `siteUrl` | env `SAFE_DEPLOY_SITE_URL` o `VITE_SITE_URL` | Sitio en producción. |
| `retentionDays` | `30` | Días que se conservan los assets viejos. |
| `carryOver` | `true` | `false` para no descargar assets anteriores. |
| `headers` | `{}` | Headers extra (CSP, HSTS…) para `/*` cuando `_headers` se genera. |
| `notFound` | textos en español | Textos de la página 404 generada. |
| `texts` | textos en español | Textos de la pantalla "Actualizando la página…". |
| `host` | `'cloudflare-pages'` | `'none'` = solo guard + assets anteriores. |
| `strict` | `false` | `true`: el build falla si hay problemas. |

## Sin Vite (Astro, sitio estático, etc.)

```bash
# después del build del framework
npx safe-deploy prepare --dir dist --assets _astro --site https://midominio.com --route blog/x
```

Y agrega a mano, como primer script del `<head>`: `<script src="/stale-asset-guard.js"></script>`.

## Lo que NO resuelve

Durante los segundos en que el hosting propaga un deploy, quien entre por primera vez puede ver "Actualizando la página…" un momento; la página entra sola cuando los archivos están disponibles. En la consola queda un `404` de ese instante: es esperado.

## Más

- [docs/cloudflare-pages.md](docs/cloudflare-pages.md): el porqué de cada regla y diagnóstico de errores.
- [skill/SKILL.md](skill/SKILL.md): Skill de Claude Code para aplicar y verificar esto en cualquier proyecto.

## Desarrollo

```bash
npm test
```

Sin dependencias ni paso de compilación: se instala directo desde GitHub.
