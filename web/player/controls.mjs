// Neutral input mapping (CONTRACTS §3, §11.1). Keys come from the adapter's `controls` table; gamepads use the fixed
// W3C "standard" layout below. Only button names the adapter has are ever produced. Pure functions, no DOM.

/** W3C standard gamepad index -> canonical button name. Fixed for every adapter (§11.1). */
export const STANDARD_PAD = Object.freeze({
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'L', 5: 'R', 6: 'L2', 7: 'R2',
  8: 'SELECT', 9: 'START', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT',
});

const DEADZONE = 0.5;
const KEY_LABELS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const PAD_LABELS = {
  UP: 'D-pad ↑', DOWN: 'D-pad ↓', LEFT: 'D-pad ←', RIGHT: 'D-pad →',
  L: 'LB', R: 'RB', L2: 'LT', R2: 'RT', START: 'Menu ≡', SELECT: 'View ⧉',
};

/** KeyboardEvent.code -> canonical button name, or null. `controls` is the adapter's table. */
export function keyName(controls, code) {
  return controls && Object.hasOwn(controls, code) ? controls[code] : null;
}

/** Button names pressed on a W3C standard pad, restricted to `order` (the adapter's buttons). Left stick past the
 *  deadzone counts as the D-pad. Non-standard pads produce nothing. */
export function padNames(order, gp) {
  if (!gp || gp.mapping !== 'standard') return [];
  const names = [];
  for (const [i, name] of Object.entries(STANDARD_PAD)) {
    if (order.includes(name) && gp.buttons[i]?.pressed) names.push(name);
  }
  const [x = 0, y = 0] = gp.axes ?? [];
  const stick = { LEFT: x <= -DEADZONE, RIGHT: x >= DEADZONE, UP: y <= -DEADZONE, DOWN: y >= DEADZONE };
  for (const [name, on] of Object.entries(stick)) if (on && order.includes(name)) names.push(name);
  return [...new Set(names)];
}

/** Short label for a KeyboardEvent.code: arrows as glyphs, KeyX -> X, others as-is. */
export function keyLabel(code) {
  return KEY_LABELS[code] ?? code.replace(/^Key/, '');
}

/** Legend rows for the page: one per adapter button, in the adapter's bit order. `key` is the first key bound to it
 *  in adapter.controls (null if none); `pad` is the pad label. */
export function legendFor(adapter) {
  const keyOf = {};
  for (const [code, name] of Object.entries(adapter.controls ?? {})) {
    if (!Object.hasOwn(keyOf, name)) keyOf[name] = code;
  }
  return adapter.buttons.map(name => ({
    name,
    key: Object.hasOwn(keyOf, name) ? keyLabel(keyOf[name]) : null,
    pad: PAD_LABELS[name] ?? name,
  }));
}
