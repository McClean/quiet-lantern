// Real NES ROM through the shared libretro binding, gated on HERMES_NES_ROM (path to a local .nes file).
// Skipped when the variable is unset, so CI never needs a game file. The ROM is read into memory only;
// nothing is copied into the repo or written to disk. Run:
//   HERMES_NES_ROM="<path to your own .nes>" node --test adapters/quicknes/test/gated-real-rom.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { instantiateCore } from './lib/instantiate.mjs';
import bind from '../binding.mjs';

const ROM_PATH = process.env.HERMES_NES_ROM;
const gate = ROM_PATH ? {} : { skip: 'set HERMES_NES_ROM to a local .nes file to run' };

// NES joypad bit positions in the libretro order used by binding.mjs (manifest buttons).
const LIBRETRO_BUTTONS = ['B', 'Y', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'X', 'L', 'R', 'L2', 'R2'];
const maskFor = names => names.reduce((m, n) => m | (1 << LIBRETRO_BUTTONS.indexOf(n)), 0);

// Distinct RGB colours in rows [y0, y1) of an RGBA buffer `w` pixels wide.
function distinctColours(rgba, w, y0 = 0, y1 = rgba.length / 4 / w) {
  const seen = new Set();
  for (let i = y0 * w * 4; i < y1 * w * 4; i += 4) {
    seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  return seen.size;
}

async function open() {
  const h = bind(await instantiateCore());
  const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
  assert.equal(h.load(rom), true, 'retro_load_game accepts the ROM');
  return h;
}

test('real NES ROM: loads and renders a non-uniform picture after 300 frames', gate, async () => {
  const h = await open();
  for (let i = 0; i < 300; i++) h.runFrame();
  assert.equal(h.frame(), 300);
  const { width, height, rgba } = h.video();
  assert.equal(width, 240);
  assert.equal(height, 224);
  assert.ok(distinctColours(rgba, width) > 1, 'whole frame has more than one colour');
  // Regression guard for the top-strip artefact seen in the spike's synthetic ROM: rows 0-36 must vary.
  assert.ok(distinctColours(rgba, width, 0, 37) > 1, 'top 37 rows have more than one colour');
});

test('real NES ROM: pressing Start changes the picture', gate, async () => {
  const h = await open();
  for (let i = 0; i < 300; i++) h.runFrame();
  const before = h.video().rgba.slice();
  h.setButtons(maskFor(['START']));
  for (let i = 0; i < 4; i++) h.runFrame();
  h.setButtons(0);
  for (let i = 0; i < 120; i++) h.runFrame();
  assert.notDeepEqual(h.video().rgba, before, 'Start changes the rendered frame');
});

test('real NES ROM: audio is produced during play', gate, async () => {
  const h = await open();
  for (let i = 0; i < 300; i++) h.runFrame();
  const s = h.audio();
  assert.ok(s.length > 0, 'samples returned');
  assert.ok(s.some(v => v !== 0), 'not all silence');
});
