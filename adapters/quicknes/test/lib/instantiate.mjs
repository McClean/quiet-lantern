// Loads a built adapter's core.mjs + core.wasm in Node the same way the player does: the wasm
// bytes are handed in through instantiateWasm, so the loader needs no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADAPTER = path.resolve(here, '../..');

export async function instantiateCore(adapterDir = ADAPTER) {
  const bytes = fs.readFileSync(path.join(adapterDir, 'core', 'core.wasm'));
  const { default: create } = await import(pathToFileURL(path.join(adapterDir, 'core', 'core.mjs')).href);
  return create({
    instantiateWasm(imports, ok) {
      WebAssembly.instantiate(bytes, imports).then(r => ok(r.instance, r.module));
      return {};
    },
  });
}

// Copy `bytes` into the module heap; the caller frees the pointer.
export function putBytes(M, bytes) {
  const p = M._malloc(Math.max(bytes.length, 1));
  M.HEAPU8.set(bytes, p);
  return p;
}
