// Contract v1: the CoreHandle, pack and host-message checks every adapter and pack must pass.
// Pure ES module, no DOM: runs in the player frame, the Desktop host and node --test.

export const CONTRACT = 1;

/** §3 canonical button names. An adapter's manifest `buttons` array = its bit order (bit i = buttons[i]). */
export const BUTTONS = Object.freeze(['A', 'B', 'X', 'Y', 'L', 'R', 'L2', 'R2', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT']);

/** §2 methods every CoreHandle must have. */
export const CORE_METHODS = Object.freeze([
  'load', 'unload', 'runFrame', 'frame', 'fps', 'setButtons', 'video', 'stateSize', 'saveState', 'loadState', 'read',
]);

/** §2 methods required only when the manifest declares the capability (capability -> methods). */
export const OPTIONAL_CORE_METHODS = Object.freeze({
  audio: Object.freeze(['audio']),
  battery_save: Object.freeze(['batterySave', 'loadBatterySave']),
});

/** §4 functions a pack.mjs may export; the manifest's `provides` lists which. */
export const PACK_FUNCTIONS = Object.freeze(['gameplayMode', 'isPaused', 'readState', 'actors', 'slot']);

export const GAMEPLAY_MODES = Object.freeze([
  'free_roam', 'menu', 'dialogue_printing', 'dialogue_waiting', 'battle', 'cutscene_setup', 'unknown',
]);

/** Button names -> mask in this adapter's bit order. Throws on a name the adapter does not have. */
export function maskFor(order, names) {
  let mask = 0;
  for (const n of names) {
    const bit = order.indexOf(n);
    if (bit < 0) throw new Error(`button ${n} not on this adapter (has ${order.join(',')})`);
    mask |= 1 << bit;
  }
  return mask;
}

/** Mask -> button names, in bit order. */
export const namesFor = (order, mask) => order.filter((_, bit) => mask & (1 << bit));

function missing(obj, names) {
  return names.filter(n => typeof obj?.[n] !== 'function');
}

/** Throw unless `handle` implements the Core ABI for these capabilities. Every binding test calls this. */
export function assertCoreHandle(handle, capabilities = []) {
  const need = [...CORE_METHODS];
  for (const cap of capabilities) need.push(...(OPTIONAL_CORE_METHODS[cap] ?? []));
  const gone = missing(handle, need);
  if (gone.length) throw new Error(`CoreHandle missing: ${gone.join(', ')}`);
}

/** Throw unless `pack` exports every function its manifest `provides`. */
export function assertPack(pack, provides = []) {
  const unknown = provides.filter(n => !PACK_FUNCTIONS.includes(n));
  if (unknown.length) throw new Error(`unknown pack function(s): ${unknown.join(', ')}`);
  const gone = missing(pack, provides);
  if (gone.length) throw new Error(`pack missing: ${gone.join(', ')}`);
}
