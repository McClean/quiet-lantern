// Host-level audio ring (libretro/hm_libretro.c). Runs the built core with the synthetic ROM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateCore, putBytes } from './lib/instantiate.mjs';
import { buildNesRom } from './lib/nes-rom.mjs';

const ROM = buildNesRom();

async function loaded() {
  const M = await instantiateCore();
  M._hm_lr_init();
  const p = putBytes(M, ROM);
  try {
    assert.equal(M._hm_lr_load(p, ROM.length), 1, 'retro_load_game');
  } finally {
    M._free(p);
  }
  return M;
}

// Drain up to maxFrames stereo frames; returns the Int16Array of interleaved samples.
function drain(M, maxFrames) {
  const p = M._malloc(maxFrames * 4);
  try {
    const n = M._hm_lr_audio_read(p, maxFrames);
    const bytes = M.HEAPU8.slice(p, p + n * 4);
    return new Int16Array(bytes.buffer, 0, n * 2);
  } finally {
    M._free(p);
  }
}

test('host: 60 frames leave about rate/fps*60 stereo frames in the audio ring', async () => {
  const M = await loaded();
  const rate = M._hm_lr_audio_rate();
  assert.ok(rate > 0, `audio rate must be > 0, got ${rate}`);
  M._hm_lr_step(60);
  const fps = M._hm_lr_fps() / 1000;
  const expected = (rate * 60) / fps;
  const got = drain(M, 1 << 16).length / 2;
  assert.ok(Math.abs(got - expected) <= expected * 0.05,
    `expected ~${expected.toFixed(0)} stereo frames, got ${got}`);
});

test('host: audio_read drains the ring, so a second read with no frames run returns nothing', async () => {
  const M = await loaded();
  M._hm_lr_step(10);
  drain(M, 1 << 16);
  assert.equal(drain(M, 1 << 16).length, 0);
});
