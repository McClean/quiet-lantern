// Neutral input mapping (CONTRACTS §11.1). Keyboard comes from adapter.controls; gamepad from the fixed
// W3C standard table. Only names the adapter has are ever produced. Run: node --test web/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_PAD, keyName, padNames, legendFor, keyLabel } from '../player/controls.mjs';
import { FAKE_ADAPTER, pad } from './support/fakes.mjs';

const ORDER = FAKE_ADAPTER.buttons;
const FULL_ORDER = ['A', 'B', 'X', 'Y', 'L', 'R', 'L2', 'R2', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT'];

test('keyName maps a key through the adapter controls table', () => {
  assert.equal(keyName(FAKE_ADAPTER.controls, 'KeyX'), 'A');
  assert.equal(keyName(FAKE_ADAPTER.controls, 'KeyZ'), 'B');
  assert.equal(keyName(FAKE_ADAPTER.controls, 'KeyQ'), null);
});

test('keys not listed in the adapter controls are ignored, even the GBA defaults', () => {
  assert.equal(keyName(FAKE_ADAPTER.controls, 'ArrowUp'), null);
  assert.equal(keyName(FAKE_ADAPTER.controls, 'Enter'), null);
});

test('padNames returns only standard buttons the adapter has', () => {
  // 0 = A (on the adapter), 2 = X (not on a 2-button adapter), 9 = START (not on it either).
  assert.deepEqual(padNames(ORDER, pad([0, 2, 9])), ['A']);
});

test('padNames uses the fixed W3C standard table', () => {
  assert.deepEqual(STANDARD_PAD, { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'L', 5: 'R', 6: 'L2', 7: 'R2', 8: 'SELECT', 9: 'START', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT' });
  assert.deepEqual(padNames(FULL_ORDER, pad([2, 3, 6, 7])), ['X', 'Y', 'L2', 'R2']);
});

test('padNames ignores non-standard pads and reads the left stick past the deadzone as the D-pad', () => {
  assert.deepEqual(padNames(FULL_ORDER, { mapping: '', axes: [], buttons: [] }), []);
  assert.deepEqual(padNames(FULL_ORDER, null), []);
  assert.deepEqual(padNames(FULL_ORDER, pad([], [-0.9, 0.8, 0, 0])).sort(), ['DOWN', 'LEFT']);
  assert.deepEqual(padNames(FULL_ORDER, pad([], [0.3, -0.3, 0, 0])), []);
});

test('legendFor lists exactly the adapter buttons, in its order, with the key labels from its controls', () => {
  assert.deepEqual(legendFor(FAKE_ADAPTER, false), [
    { name: 'A', key: 'X', pad: 'A' },
    { name: 'B', key: 'Z', pad: 'B' },
  ]);
});

test('keyLabel shows a short label for a KeyboardEvent.code', () => {
  assert.equal(keyLabel('KeyX'), 'X');
  assert.equal(keyLabel('ArrowUp'), '↑');
  assert.equal(keyLabel('Enter'), 'Enter');
});
