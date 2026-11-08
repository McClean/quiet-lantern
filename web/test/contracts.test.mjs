// Contract v1 §2–§4 (docs/CONTRACTS.md). Run: node --test web/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT, BUTTONS, CORE_METHODS, OPTIONAL_CORE_METHODS, PACK_FUNCTIONS, GAMEPLAY_MODES,
  maskFor, namesFor, assertCoreHandle, assertPack,
} from '../engine/contracts.mjs';

const mgba = JSON.parse(readFileSync(new URL('../../adapters/mgba/manifest.json', import.meta.url)));

test('contract version is 1', () => assert.equal(CONTRACT, 1));

test('canonical buttons match the adapter schema enum', () => {
  const schema = JSON.parse(readFileSync(new URL('../../contracts/adapter-manifest.schema.json', import.meta.url)));
  assert.deepEqual([...BUTTONS], schema.properties.buttons.items.enum);
});

test('maskFor/namesFor use the adapter bit order (bit i = buttons[i])', () => {
  const order = mgba.buttons;
  for (const name of order) assert.equal(maskFor(order, [name]), 1 << order.indexOf(name));
  assert.equal(maskFor(order, ['A', 'START']), 0b1001);
  assert.deepEqual(namesFor(order, 0b1001), ['A', 'START']);
});

test('maskFor rejects a button the adapter does not have', () => {
  assert.throws(() => maskFor(mgba.buttons, ['X']), /X/);
});

const fakeCore = (extra = {}) => Object.fromEntries([...CORE_METHODS].map(m => [m, () => {}]).concat(Object.entries(extra)));

test('assertCoreHandle accepts a complete handle', () => {
  assert.doesNotThrow(() => assertCoreHandle(fakeCore({ audio() {} }), mgba.capabilities));
});

test('assertCoreHandle names every missing method', () => {
  const h = fakeCore();
  delete h.read; delete h.saveState;
  assert.throws(() => assertCoreHandle(h, []), /read.*saveState|saveState.*read/);
});

test('assertCoreHandle requires optional methods only when the capability is declared', () => {
  assert.doesNotThrow(() => assertCoreHandle(fakeCore(), ['video']));
  assert.throws(() => assertCoreHandle(fakeCore(), ['audio']), /audio/);
  assert.throws(() => assertCoreHandle(fakeCore(), ['battery_save']), /batterySave/);
  assert.doesNotThrow(() => assertCoreHandle(fakeCore({ audio() {} }), ['audio']));
  assert.deepEqual(Object.keys(OPTIONAL_CORE_METHODS).sort(), ['audio', 'battery_save']);
});

test('assertPack checks the functions the manifest says it provides', () => {
  const pack = { gameplayMode: () => 'unknown', readState: () => ({}) };
  assert.doesNotThrow(() => assertPack(pack, ['gameplayMode', 'readState']));
  assert.throws(() => assertPack(pack, ['actors']), /actors/);
  assert.throws(() => assertPack(pack, ['teleport']), /teleport/);
  assert.deepEqual([...PACK_FUNCTIONS], ['gameplayMode', 'isPaused', 'readState', 'actors', 'slot']);
});

test('gameplay modes are the fixed set', () => {
  assert.deepEqual([...GAMEPLAY_MODES],
    ['free_roam', 'menu', 'dialogue_printing', 'dialogue_waiting', 'battle', 'cutscene_setup', 'unknown']);
});
