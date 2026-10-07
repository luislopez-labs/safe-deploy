import type { Plugin } from 'vite';

export interface SafeDeployOptions {
  /** Hosting de destino. Default: 'cloudflare-pages'. 'none' = solo guard + assets anteriores. */
  host?: 'cloudflare-pages' | 'none';
  /**
   * Rutas de la app (SPA) que deben recibir index.html al abrirlas por URL.
   * Usa comodín para las dinámicas: ['/producto/*', '/contacto']. "/" no hace falta.
   * Si el proyecto ya trae public/_redirects, no se genera: solo se verifica que las cubra.
   */
  routes?: string[];
  /** URL del sitio en producción. Default: env SAFE_DEPLOY_SITE_URL o VITE_SITE_URL. */
  siteUrl?: string;
  /** Días que se conservan los assets de builds anteriores. Default: 30. */
  retentionDays?: number;
  /** false para no descargar los assets de builds anteriores. */
  carryOver?: boolean;
  /** Headers extra (seguridad, CSP…) para la regla "/*" cuando _headers se genera. */
  headers?: Record<string, string>;
  /** Textos de la página 404 generada. */
  notFound?: { lang?: string; title?: string; message?: string; homeLabel?: string };
  /** Textos de la pantalla de recuperación. */
  texts?: {
    updatingTitle?: string;
    updatingBody?: string;
    failedTitle?: string;
    failedBody?: string;
    retry?: string;
  };
  /** true: el build falla si hay algún problema (recomendado en CI). Default: false (solo avisa). */
  strict?: boolean;
}

export function safeDeploy(options?: SafeDeployOptions): Plugin;
export default safeDeploy;
