import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
let active: string | undefined;
let fallback = false;
let warned = false;

function createRoot(parent: string) {
  const real = realpathSync(parent);
  const rel = relative(checkout, real);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) {
    throw Error('store parent is inside the bot checkout');
  }
  return mkdtempSync(join(real, 'forge-store-'));
}

function logFallback(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn('[store] falling back to temporary storage:', error instanceof Error ? error.message : error);
}

export function initializeStore() {
  if (active) return;
  const preferred = process.env.MAKEFUN_GIT_STORE || process.env.MAKEFUN_STATE_DIR;
  if (preferred) {
    try { active = createRoot(preferred); return; }
    catch (error) { logFallback(error); }
  }
  try { active = createRoot(tmpdir()); fallback = true; }
  catch (error) { console.error('[store] temporary storage unavailable:', error); }
}

export function storeRoot() {
  if (!active) throw Error('store unavailable');
  return active;
}

export function storeOperation<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (!active || fallback || !['EACCES', 'EROFS', 'EPERM'].includes(failure.code ?? '')) throw error;
    logFallback(error);
    const next = createRoot(tmpdir());
    // Keep the original store selected unless its contents were copied successfully.
    cpSync(active, next, { recursive: true });
    active = next;
    fallback = true;
    return operation();
  }
}
