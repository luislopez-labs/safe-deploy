/** ¿El mensaje de error corresponde a un chunk/asset que no se pudo cargar? */
export function isChunkLoadFailure(message: unknown): boolean;
/** Inicia la recuperación tras un fallo de chunk. true si la página va a recargarse. */
export function recoverFromChunkError(message?: string): boolean;
/** Escucha los errores de carga de chunks y recupera la página. Idempotente. */
export function installChunkRecovery(): void;

declare global {
  interface Window {
    __recoverStaleAsset?: (url?: string) => void;
  }
}
