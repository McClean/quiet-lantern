// Headless smoke: boot a ROM in our mgba.wasm under Node, run N frames, report frame count
// and how many non-black pixels are on screen. Usage: node smoke.mjs <rom.gba> [frames]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../adapters/mgba/core');
globalThis.self = globalThis; // ENVIRONMENT=web build expects a web global
const createMgba = (await import(path.join(dist, 'mgba.mjs').replace(/\\/g, '/').replace(/^([A-Z]:)/, 'file:///$1'))).default;
const wasmBytes = readFileSync(path.join(dist, 'mgba.wasm'));
const M = await createMgba({
  instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmBytes, imports).then(r => done(r.instance)); return {}; },
});

const rom = readFileSync(process.argv[2]);
const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
const ok = M._hm_load(p, rom.length);
M._free(p);
if (!ok) { console.log(JSON.stringify({ ok: false })); process.exit(1); }

const frames = Number(process.argv[3] || 600);
for (let i = 0; i < frames; i++) M._hm_run_frame();
const w = M._hm_video_width(), h = M._hm_video_height(), stride = M._hm_video_stride();
const bpp = M._hm_bytes_per_pixel();
const base = M._hm_video_ptr();
let lit = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const o = base + (y * stride + x) * bpp;
  const v = bpp === 4 ? M.HEAPU32[o >> 2] & 0xffffff : M.HEAPU16[o >> 1];
  if (v) lit++;
}
console.log(JSON.stringify({ ok: true, frame: M._hm_frame(), w, h, bpp, lit, total: w * h, rate: M._hm_sample_rate(), state: M._hm_state_size() }));
