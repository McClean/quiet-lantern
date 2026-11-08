// Audio state must not leak across games: loading a new ROM starts with an empty ring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateCore } from './lib/instantiate.mjs';
import { buildNesRom } from './lib/nes-rom.mjs';
import bind from '../binding.mjs';

test('binding: a second load() drops audio left over from the previous game', async () => {
  const h = bind(await instantiateCore());
  const rom = buildNesRom();
  assert.equal(h.load(rom), true);
  for (let i = 0; i < 60; i++) h.runFrame();
  assert.equal(h.load(rom), true, 'second load');
  assert.equal(h.audio().length, 0, 'nothing from the previous game is left to drain');
});
