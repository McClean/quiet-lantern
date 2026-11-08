// Integration (CONTRACTS §11.1 + §2): the real mGBA core + binding, driven by the neutral player, on a synthetic ROM
// that paints the screen red. No game data. Run: node --test web/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCoreHandle, maskFor } from '../engine/contracts.mjs';
import * as controls from '../player/controls.mjs';
import { createPlayer } from '../player/player.mjs';
import { paintRom } from './support/synthetic.mjs';

const ADAPTER = new URL('../../adapters/mgba/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', ADAPTER), 'utf-8'));
const coreSrc = readFileSync(new URL('core/mgba.mjs', ADAPTER), 'utf-8');
const bindingSrc = readFileSync(new URL('binding.mjs', ADAPTER), 'utf-8');
const wasm = readFileSync(new URL('core/mgba.wasm', ADAPTER));

// The page imports sources as blob modules; in Node a data: URL plays the same role.
const importModule = src => import('data:text/javascript;base64,' + Buffer.from(src, 'utf-8').toString('base64'));

function surfaceSpy() {
  const s = { w: 0, h: 0, last: null, sizes: [] };
  return Object.assign(s, {
    resize(w, h) { s.sizes.push([w, h]); s.w = w; s.h = h; },
    present(rgba, w, h) { s.last = { rgba: Uint8ClampedArray.from(rgba), w, h }; },
    async png() { return new ArrayBuffer(0); },
  });
}

test('mGBA through the neutral player: load sizes 240x160 and the paint ROM turns the screen red', async () => {
  const surface = surfaceSpy();
  let clock = 0;
  const player = createPlayer({
    contracts: { assertCoreHandle, maskFor }, controls, importModule, surface,
    audio: { start() {}, push() {} },
    sleep: async () => { clock += 17; player.tick(clock); },
  });
  const r = await player.handle({
    op: 'load', id: 'l', adapter: manifest, coreSrc, bindingSrc, wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    rom: paintRom().buffer,
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(surface.sizes[0], [240, 160]);
  for (let i = 0; i < 6; i++) player.tick(clock += 17);
  const px = surface.last;
  assert.equal(px.w, 240); assert.equal(px.h, 160);
  assert.equal(px.rgba.length, 240 * 160 * 4);
  // Centre pixel: red-dominant, opaque. BGR555 0x001F is pure red; mGBA expands it to 8-bit.
  const i = (80 * 240 + 120) * 4;
  assert.ok(px.rgba[i] > 200 && px.rgba[i + 1] < 40 && px.rgba[i + 2] < 40, `centre pixel ${[...px.rgba.slice(i, i + 4)]}`);
  assert.equal(px.rgba[i + 3], 255);
});
