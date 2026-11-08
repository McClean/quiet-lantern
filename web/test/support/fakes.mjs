// Test doubles for the neutral player (CONTRACTS §11.1). No wasm, no DOM, no game data.
// Run: node --test web/test/*.test.mjs

// The player imports core and binding sources as modules; in Node a data: URL does the same job as a blob URL.
export const importSource = src =>
  import('data:text/javascript;base64,' + Buffer.from(src, 'utf-8').toString('base64'));

// A core whose factory returns an empty Module. The binding decides what it can do.
export const CORE_SRC = 'export default async function create() { return {}; }';

// A CoreHandle over nothing: 4x2 video, one frame per runFrame(), an empty audio buffer per audio() call.
// Calls are recorded on globalThis.__fake (set by the harness). The ROM is accepted when its first byte is 'R'.
// `omit` deletes methods so a test can see assertCoreHandle name them.
export function bindingSrc(omit = []) {
  return `export default function bind(M) {
    let frame = 0;
    const rec = () => globalThis.__fake;
    const h = {
      load(bytes) { return bytes[0] === 0x52; },
      unload() {},
      runFrame() { frame++; rec().frames++; },
      frame() { return frame; },
      fps() { return 60; },
      setButtons(m) { rec().masks.push(m); },
      video() { return { width: 4, height: 2, rgba: new Uint8ClampedArray(32).fill(255) }; },
      stateSize() { return 4; },
      saveState() { return new Uint8Array(4); },
      loadState() { return true; },
      read(addr, len) { rec().reads.push([addr, len]); return new Uint8Array(len); },
      audio() { return new Int16Array(4); },
    };
    for (const k of ${JSON.stringify(omit)}) delete h[k];
    return h;
  }`;
}

export const romBytes = (text = 'Rom') => new TextEncoder().encode(text).buffer;

export const FAKE_ADAPTER = Object.freeze({
  id: 'fake',
  name: 'Fake',
  buttons: ['A', 'B'],
  controls: { KeyX: 'A', KeyZ: 'B' },
  capabilities: ['video', 'audio'],
  systems: [{ id: 'fake', name: 'Fake' }],
});

export function fakeSurface() {
  const sizes = [], presents = [], pngs = [];
  return {
    sizes,
    presents,
    pngs,
    resize(w, h) { sizes.push({ w, h }); },
    present(rgba, w, h) { presents.push({ w, h, bytes: rgba.length }); },
    async png(rgba, w, h) { pngs.push({ w, h, bytes: rgba.length }); return new Uint8Array([137, 80, 78, 71]).buffer; },
  };
}

export function fakeAudio() {
  const starts = [], pushes = [];
  return { starts, pushes, start(rate) { starts.push(rate); }, push(samples) { pushes.push(samples.length); } };
}

// Standard W3C gamepad shape as the host forwards it (`t:'host-pad'`).
export const pad = (pressed = [], axes = [0, 0, 0, 0]) => ({
  mapping: 'standard',
  id: 'Xbox',
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
});
