// Neutral player (CONTRACTS §11.1). The player logic is a DOM-free module; index.html only wires it to the page.
// Run: node --test web/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCoreHandle, maskFor } from '../engine/contracts.mjs';
import * as controls from '../player/controls.mjs';
import { createPlayer, advance, fitSize, parseSteps, DEFAULT_AUDIO_RATE, MAX_CATCHUP } from '../player/player.mjs';
import { importSource, CORE_SRC, bindingSrc, romBytes, FAKE_ADAPTER, fakeSurface, fakeAudio, pad } from './support/fakes.mjs';

const INDEX = new URL('../player/index.html', import.meta.url);

// Each harness has its own player, surface and audio sink. run(n) ticks the loop n times at 17 ms (about one frame).
function harness({ adapter = FAKE_ADAPTER, binding = bindingSrc(), noTick = false } = {}) {
  globalThis.__fake = { masks: [], frames: 0, reads: [] };
  let clock = 0;
  const surface = fakeSurface();
  const audio = fakeAudio();
  let player;
  // Waiting inside press() advances the clock and ticks the loop, as the page's timers do.
  // noTick models a hidden tab: the default timer advances time but never calls tick(), so only press() can progress.
  const sleep = async () => { clock += 17; if (!noTick) player.tick(clock); };
  player = createPlayer({
    contracts: { assertCoreHandle, maskFor },
    controls,
    importModule: importSource,
    surface,
    audio,
    sleep,
  });
  const run = n => { for (let i = 0; i < n; i++) player.tick(clock += 17); };
  return {
    player, surface, audio, run,
    load: (extra = {}) => player.handle({
      op: 'load', id: 'l1', adapter, coreSrc: CORE_SRC, bindingSrc: binding, wasm: new ArrayBuffer(8), rom: romBytes(), ...extra,
    }),
    op: m => player.handle({ id: 'x', ...m }),
  };
}

test('load sizes the canvas to the core video and presents the first frame', async () => {
  const h = harness();
  const r = await h.load();
  assert.equal(r.ok, true);
  assert.deepEqual(h.surface.sizes[0], { w: 4, h: 2 });
  assert.deepEqual(h.surface.presents[0], { w: 4, h: 2, bytes: 32 });
});

test('load replies ok:false naming the CoreHandle method the binding is missing', async () => {
  const h = harness({ binding: bindingSrc(['read']) });
  const r = await h.load();
  assert.equal(r.ok, false);
  assert.match(r.error, /read/);
});

test('load replies ok:false when the core refuses the ROM bytes', async () => {
  const h = harness();
  const r = await h.load({ rom: new TextEncoder().encode('Not a rom').buffer });
  assert.equal(r.ok, false);
  assert.match(r.error, /ROM/);
});

test('keyboard keys reach the core only through adapter.controls', async () => {
  const h = harness();
  await h.load();
  h.player.keyDown('KeyX');
  h.run(1);
  assert.equal(globalThis.__fake.masks.at(-1), 1);       // A = bit 0 on this adapter
  h.player.keyDown('KeyZ');
  h.run(1);
  assert.equal(globalThis.__fake.masks.at(-1), 3);       // A|B
  assert.equal(h.player.keyDown('ArrowUp'), false);      // not in this adapter's controls
});

test('gamepad standard button 0 presses A on the core', async () => {
  const h = harness();
  await h.load();
  h.player.setPads([pad([0])]);
  h.run(1);
  assert.equal(globalThis.__fake.masks.at(-1), 1);
});

test('gamepad button 2 (X) is ignored when the adapter has no X', async () => {
  const h = harness();
  await h.load();
  h.player.setPads([pad([2])]);
  h.run(1);
  assert.equal(globalThis.__fake.masks.at(-1), 0);
});

test('mute stops audio being pushed to the sink until unmuted', async () => {
  const h = harness();
  await h.load();
  h.run(2);
  assert.ok(h.audio.pushes.length > 0, 'audio flows before mute');
  const r = await h.op({ op: 'mute', muted: true });
  assert.equal(r.ok, true);
  const before = h.audio.pushes.length;
  h.run(3);
  assert.equal(h.audio.pushes.length, before);
  await h.op({ op: 'mute', muted: false });
  h.run(2);
  assert.ok(h.audio.pushes.length > before);
});

test('press taps a named button on the core', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'press', steps: ['A', 'WAIT:2'] });
  assert.equal(r.ok, true);
  assert.ok(globalThis.__fake.masks.includes(1), 'A was held');
});

test('press refuses a button name the adapter does not have', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'press', steps: ['X'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown button X/);
});

test('screenshot is a PNG of the core video at its size', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'screenshot' });
  assert.equal(r.ok, true);
  assert.ok(r.png instanceof ArrayBuffer);
  assert.deepEqual(h.surface.pngs[0], { w: 4, h: 2, bytes: 32 });
});

test('read goes to handle.read(addr, len)', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'read', addr: 0x02000000, len: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes.length, 4);
  assert.deepEqual(globalThis.__fake.reads[0], [0x02000000, 4]);
});

test('status reports the adapter id', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'status' });
  assert.equal(r.ok, true);
  assert.equal(r.adapter, 'fake');
});

test('mappedName returns the adapter button for a key, or null', async () => {
  const h = harness();
  await h.load();
  assert.equal(h.player.mappedName('KeyX'), 'A');
  assert.equal(h.player.mappedName('ArrowUp'), null);
});

test('pause stops the loop and resume restarts it', async () => {
  const h = harness();
  await h.load();
  h.run(2);
  const f = globalThis.__fake.frames;
  await h.op({ op: 'pause', paused: true });
  assert.equal(h.player.isRunning(), false);
  h.run(3);
  assert.equal(globalThis.__fake.frames, f, 'no frames run while paused');
  await h.op({ op: 'pause', paused: false });
  assert.equal(h.player.isRunning(), true);
  h.run(1);
  assert.ok(globalThis.__fake.frames > f, 'frames run again after resume');
});

test('activeMask reports the buttons held from keyboard and pad, in the adapter bit order', async () => {
  const h = harness();
  await h.load();
  h.player.keyDown('KeyZ');
  h.player.setPads([pad([0])]);
  assert.equal(h.player.activeMask(), 0b11);            // B (bit 1) from keyboard, A (bit 0) from pad
});

test('an adapter without the audio capability never starts or feeds audio', async () => {
  const h = harness({ adapter: { ...FAKE_ADAPTER, capabilities: ['video'] } });
  await h.load();
  h.run(4);
  assert.deepEqual(h.audio.starts, []);
  assert.deepEqual(h.audio.pushes, []);
});

test('audio starts at the adapter audioRate when given, else 48 kHz', async () => {
  const h = harness({ adapter: { ...FAKE_ADAPTER, audioRate: 32768 } });
  await h.load();
  assert.deepEqual(h.audio.starts, [32768]);
  const g = harness();
  await g.load();
  assert.deepEqual(g.audio.starts, [48000]);
});

test('load without a rom replies ok:false naming the missing field', async () => {
  const h = harness();
  const r = await h.load({ rom: undefined });
  assert.equal(r.ok, false);
  assert.match(r.error, /rom/);
});

test('controls op returns one legend row per adapter button, in its order', async () => {
  const h = harness();
  await h.load();
  const r = await h.op({ op: 'controls' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels.map(row => row.name), ['A', 'B']);
  assert.equal(r.labels[0].key, 'X');
});

test('the player page names no emulator: index.html has no GBA, _hm_ or mgba strings', () => {
  const html = readFileSync(INDEX, 'utf-8');
  assert.doesNotMatch(html, /\bGBA\b|_hm_|mgba/);   // whole word: 'rgba' is pixel format, not an emulator name
});

test('fitSize picks the largest integer scale that fits, never below 1', () => {
  assert.equal(fitSize(240, 160, 1000, 500), 3);
  assert.equal(fitSize(240, 160, 100, 50), 1);
});

test('advance runs at most MAX_CATCHUP frames per tick and clamps the accumulator', () => {
  assert.equal(MAX_CATCHUP, 4);
  const r = advance(0, 100, 1000 / 60, MAX_CATCHUP);
  assert.equal(r.frames, 4);
  assert.ok(Math.abs(r.acc - (100 - 4 * (1000 / 60))) < 1e-9);
  // A long stall does not bank more than MAX_CATCHUP frames of debt.
  const long = advance(0, 5000, 1000 / 60, MAX_CATCHUP);
  assert.equal(long.frames, 4);
  assert.ok(long.acc <= MAX_CATCHUP * (1000 / 60) + 1e-9);
});

test('audio defaults to 48 kHz when the adapter gives no audioRate', () => {
  assert.equal(DEFAULT_AUDIO_RATE, 48000);
});

test('parseSteps refuses an unknown button before any input is sent', () => {
  assert.throws(() => parseSteps(['A', 'Q'], FAKE_ADAPTER.buttons), /unknown button Q/);
});

test('RED: press completes with no loop ticking (hidden tab, rAF paused): waitFrames drives the core itself', async () => {
  // The page's default sleep is a bare timer that never calls tick(). A press must still finish: waitFrames steps the
  // core when nothing else advances it, instead of waiting on a loop that is paused in a hidden tab.
  const h = harness({ noTick: true });
  await h.load();
  const before = globalThis.__fake.frames;
  const r = await h.op({ op: 'press', steps: ['A'] });
  assert.equal(r.ok, true, r.error);
  assert.ok(globalThis.__fake.frames > before, 'press returned, and the core advanced');
});
