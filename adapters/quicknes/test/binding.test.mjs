// CoreHandle over the shared libretro host (CONTRACTS §2). Real build of QuickNES + hm_libretro.c,
// synthetic NES ROM generated in test/lib/nes-rom.mjs. No game file is read here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateCore } from './lib/instantiate.mjs';
import { buildNesRom } from './lib/nes-rom.mjs';
import { assertCoreHandle } from '../../../web/engine/contracts.mjs';
import bind from '../binding.mjs';

// NES joypad bit positions in the libretro order that binding.mjs uses (manifest `buttons`).
const LIBRETRO_BUTTONS = ['B', 'Y', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'X', 'L', 'R', 'L2', 'R2'];
const maskFor = names => names.reduce((m, n) => m | (1 << LIBRETRO_BUTTONS.indexOf(n)), 0);
const CAPS = ['video', 'input', 'save_state', 'memory_read', 'pause', 'step', 'audio', 'screenshot'];
const ROM = buildNesRom();

async function open() {
  const M = await instantiateCore();
  const h = bind(M);
  assert.equal(h.load(ROM), true, 'load(synthetic ROM)');
  return h;
}

test('binding: bind(Module) satisfies the CoreHandle ABI for the manifest capabilities', async () => {
  const M = await instantiateCore();
  assertCoreHandle(bind(M), CAPS);
});

test('binding: runFrame advances frame() by exactly one per call', async () => {
  const h = await open();
  assert.equal(h.frame(), 0);
  h.runFrame();
  assert.equal(h.frame(), 1);
  for (let i = 0; i < 9; i++) h.runFrame();
  assert.equal(h.frame(), 10);
});

test('binding: fps() is the core nominal rate in Hz (60.0 for QuickNES, not the x1000 value)', async () => {
  const h = await open();
  assert.ok(Math.abs(h.fps() - 60) < 0.01, `fps ${h.fps()}`);
});

test('binding: video() is non-blank after 30 frames with the backdrop as the modal colour', async () => {
  const h = await open();
  for (let i = 0; i < 30; i++) h.runFrame();
  const { width, height, rgba } = h.video();
  assert.equal(width, 240);
  assert.equal(height, 224);
  assert.equal(rgba.length, width * height * 4, 'RGBA8888, no padding');
  const seen = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  assert.ok(seen.size > 1, 'more than one colour');
  const [modal] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.equal(modal, '0,0,0', 'the $3F00 backdrop ($0F black) fills the frame');
});

test('binding: setButtons(A) sets $0011 bit7 and changes the picture', async () => {
  const h = await open();
  for (let i = 0; i < 30; i++) h.runFrame();
  assert.equal(h.read(0x0011, 1)[0] & 0x80, 0, 'A released');
  const idle = h.video().rgba.slice();
  h.setButtons(maskFor(['A']));
  for (let i = 0; i < 10; i++) h.runFrame();
  assert.equal(h.read(0x0011, 1)[0] & 0x80, 0x80, 'A pressed');
  assert.notDeepEqual(h.video().rgba, idle, 'picture changed');
  h.setButtons(0);
});

test('binding: read() returns the bytes RAM holds and zeros out of the map (no throw)', async () => {
  const h = await open();
  h.runFrame();
  h.runFrame();
  assert.deepEqual([...h.read(0x0200, 2)], [0xA5, 0x5A]);
  assert.equal(h.read(0x0200, 2).length, 2);
  // $8000 is PRG-ROM, which the host does not map: out-of-map bytes must be zeros, not an exception.
  assert.deepEqual([...h.read(0x8000, 4)], [0, 0, 0, 0]);
});

test('binding: read() of QuickNES SRAM window ($6000) returns the core value ($FF), not zeros', async () => {
  const h = await open();
  h.runFrame();
  assert.deepEqual([...h.read(0x6000, 4)], [0xFF, 0xFF, 0xFF, 0xFF]);
});

test('binding: save -> load restores RAM read() byte-for-byte', async () => {
  const h = await open();
  for (let i = 0; i < 100; i++) h.runFrame();
  const st = h.saveState();
  assert.ok(st instanceof Uint8Array && st.length === h.stateSize(), 'saveState returns stateSize() bytes');
  for (let i = 0; i < 77; i++) h.runFrame();
  const after = h.read(0, 2048);
  assert.equal(h.loadState(st), true, 'loadState');
  for (let i = 0; i < 77; i++) h.runFrame();
  assert.deepEqual(h.read(0, 2048), after, 'restored state re-run gives identical RAM');
});

test('binding: audio() returns interleaved stereo samples after frames run, audioRate > 0', async () => {
  const h = await open();
  assert.ok(h.audioRate > 0, `audioRate ${h.audioRate}`);
  assert.equal(h.audioRate, 48000, 'QuickNES core rate');
  for (let i = 0; i < 60; i++) h.runFrame();
  const s = h.audio();
  assert.ok(s instanceof Int16Array);
  assert.equal(s.length % 2, 0, 'stereo pairs');
  // About one second of audio per 60 frames at 48 kHz stereo: 96000 samples, within 5 %.
  assert.ok(Math.abs(s.length - 96000) <= 96000 * 0.05, `samples ${s.length}`);
  assert.ok(s.some(v => v !== 0), 'not all silence (pulse channel is not idle in this ROM)');
});
