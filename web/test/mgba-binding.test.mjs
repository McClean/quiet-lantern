// mGBA binding (adapters/mgba/binding.mjs): CoreHandle over the native hm_* exports. Run: node --test web/test/*.test.mjs
// Uses only synthetic GBA images built in code. No game files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCoreHandle } from '../engine/contracts.mjs';

const ADAPTER = new URL('../../adapters/mgba/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', ADAPTER), 'utf-8'));
const { default: bind } = await import(new URL('binding.mjs', ADAPTER).href);
const { default: createMgba } = await import(new URL('core/mgba.mjs', ADAPTER).href);
const wasm = readFileSync(new URL('core/mgba.wasm', ADAPTER));

globalThis.self ??= globalThis; // the ENVIRONMENT=web build expects a web global

async function freshModule() {
  return createMgba({
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasm, imports).then(r => done(r.instance)); return {}; },
  });
}

// Synthetic GBA image: 0xC0 bytes with an ARM branch at offset 3 (0xEA) and the fixed 0x96 at 0xB2.
// mGBA's detector needs both bytes. The image holds no game data.
function syntheticRom() {
  const rom = new Uint8Array(0xC0);
  rom[3] = 0xEA;
  rom[0xB2] = 0x96;
  return rom;
}

test('binding is a complete CoreHandle for the mGBA capabilities', async () => {
  const handle = bind(await freshModule());
  assertCoreHandle(handle, manifest.capabilities);
});

test('frame() advances by one per runFrame() after load() of a synthetic GBA image', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(syntheticRom()), true);
  const f0 = h.frame();
  for (let i = 0; i < 30; i++) h.runFrame();
  assert.equal(h.frame() - f0, 30);
});

test('load() returns false for bytes that are not a GBA image', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(new Uint8Array(0xC0)), false);
});

test('video() is RGBA8888 at the core size, unpadded, with opaque alpha', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(syntheticRom()), true);
  h.runFrame();
  const v = h.video();
  assert.equal(v.width, 240);
  assert.equal(v.height, 160);
  assert.ok(v.rgba instanceof Uint8ClampedArray);
  assert.equal(v.rgba.length, 240 * 160 * 4);
  let opaque = 0;
  for (let i = 3; i < v.rgba.length; i += 4) if (v.rgba[i] === 255) opaque++;
  assert.equal(opaque, 240 * 160);
});

test('read() returns zeros outside the memory map without throwing', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(syntheticRom()), true);
  assert.deepEqual([...h.read(0xF0000000, 4)], [0, 0, 0, 0]);
  const inside = h.read(0x02000000, 4);
  assert.ok(inside instanceof Uint8Array);
  assert.equal(inside.length, 4);
});

test('saveState() and loadState() round-trip the core state', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(syntheticRom()), true);
  h.runFrame();
  const s = h.saveState();
  assert.ok(s instanceof Uint8Array);
  assert.equal(s.length, h.stateSize());
  assert.equal(h.loadState(s), true);
});

test('audio() returns interleaved stereo int16 samples', async () => {
  const h = bind(await freshModule());
  assert.equal(h.load(syntheticRom()), true);
  for (let i = 0; i < 60; i++) h.runFrame();
  const a = h.audio();
  assert.ok(a instanceof Int16Array);
  assert.equal(a.length % 2, 0);
  assert.ok(a.length > 0);
});
