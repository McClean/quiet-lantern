// Core-neutral player (CONTRACTS §11.1). No emulator names here: everything core-specific arrives in `load`.
// DOM-free and import-free: the page injects `contracts` (engine/contracts.mjs), `controls` (player/controls.mjs),
// `importModule` (blob import), `surface` (canvas) and `audio` (sink). The frame inlines all three as blob modules.

export const MAX_CATCHUP = 4;             // at most this many frames per tick
export const DEFAULT_AUDIO_RATE = 48000;  // used when the adapter gives no audioRate
const MAX_STEP_MS = 250;                  // a long pause never banks more than the catch-up cap
const TAP_FRAMES = 6;
const GAP_FRAMES = 4;
const MAX_WAIT_FRAMES = 3600;
const MAX_HOLD_FRAMES = 600;
const MAX_READ = 4096;
const POLL_MS = 8;

/** Fixed-step clock. `dt` ms buys whole frames; debt beyond the catch-up cap is dropped. */
export function advance(acc, dt, frameMs, maxCatchup) {
  let a = acc + dt;
  let frames = 0;
  while (a >= frameMs && frames < maxCatchup) { a -= frameMs; frames++; }
  return { frames, acc: Math.min(a, maxCatchup * frameMs) };
}

/** Largest whole-number scale that fits w x h into maxW x maxH, never below 1. */
export function fitSize(w, h, maxW, maxH) {
  return Math.max(1, Math.floor(Math.min(maxW / w, maxH / h)));
}

/** Press steps -> ops: `A`, `WAIT:n`, `HOLD:NAME:n`. An unknown name throws before any input is sent. */
export function parseSteps(steps, buttons) {
  return steps.map(raw => {
    const [op, a, b] = String(raw).toUpperCase().split(':');
    if (op === 'WAIT') return { wait: Math.min(+a || 1, MAX_WAIT_FRAMES) };
    const name = op === 'HOLD' ? a : op;
    if (!buttons.includes(name)) throw new Error(`unknown button ${name}`);
    const hold = op === 'HOLD' ? Math.min(+b || 1, MAX_HOLD_FRAMES) : TAP_FRAMES;
    return { bit: buttons.indexOf(name), hold };
  });
}

export function createPlayer({ contracts, controls, importModule, surface, audio, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const { assertCoreHandle, maskFor } = contracts;
  const { keyName, padNames, legendFor } = controls;
  let adapter = null;      // the manifest subset passed in `load`
  let core = null;         // the CoreHandle
  let frameMs = 1000 / 60;
  let running = false;
  let last;                // previous tick time; undefined until the first tick after a load
  let acc = 0;
  let keyMask = 0, padMask = 0, agentMask = 0;
  let padId = null;
  let muted = false;
  let hasAudio = false, rate = DEFAULT_AUDIO_RATE;

  const mask = () => keyMask | padMask | agentMask;
  const bitOf = name => maskFor(adapter.buttons, [name]);

  function unload() {
    try { core?.unload?.(); } catch { /* the old core is being dropped anyway */ }
    core = null;
    running = false;
  }

  function stepFrames(n) {
    for (let i = 0; i < n; i++) {
      core.setButtons(mask());
      core.runFrame();
      if (hasAudio) {
        const s = core.audio();                 // always drain, so the core's buffer never backs up
        if (!muted && s.length) audio.push(s);
      }
    }
  }

  function present() {
    const v = core.video();
    surface.present(v.rgba, v.width, v.height);
  }

  // Waiting for n frames. The loop normally advances the core; when it cannot (a hidden tab pauses rAF, or no loop is
  // running), step the core here so press() always completes instead of waiting on a timer that never advances it.
  async function waitFrames(n) {
    if (!core) return;
    const end = core.frame() + n;
    let stalledFor = 0, seen = core.frame();
    while (running && core && core.frame() < end) {
      await sleep(POLL_MS);
      if (!core) return;
      if (core.frame() === seen) {
        stalledFor += 1;
        if (stalledFor >= 2) { stepFrames(1); present(); stalledFor = 0; }   // the loop is not advancing: drive it
      } else {
        stalledFor = 0; seen = core.frame();
      }
    }
  }

  async function press(steps) {
    for (const op of parseSteps(steps, adapter.buttons)) {
      if (op.wait !== undefined) { await waitFrames(op.wait); continue; }
      agentMask |= 1 << op.bit;
      await waitFrames(op.hold);
      agentMask &= ~(1 << op.bit);
      await waitFrames(GAP_FRAMES);
    }
  }

  async function load(m) {
    const missing = ['adapter', 'coreSrc', 'bindingSrc', 'rom'].filter(k => m[k] == null);
    if (missing.length) return { ok: false, error: `load is missing ${missing.join(', ')}` };
    let next;
    try {
      const { default: createCore } = await importModule(m.coreSrc);
      const Module = await createCore({
        instantiateWasm: (imports, done) => {
          WebAssembly.instantiate(m.wasm, imports).then(r => done(r.instance, r.module));
          return {};
        },
      });
      const { default: bind } = await importModule(m.bindingSrc);
      next = await bind(Module);
      assertCoreHandle(next, m.adapter.capabilities);
      if (!next.load(new Uint8Array(m.rom))) return { ok: false, error: 'the core refused this ROM' };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    unload();                                   // the previous game goes only once the new one is ready
    adapter = m.adapter;
    core = next;
    hasAudio = adapter.capabilities.includes('audio');
    rate = adapter.audioRate ?? DEFAULT_AUDIO_RATE;
    frameMs = 1000 / core.fps();
    keyMask = padMask = agentMask = 0;
    acc = 0;
    last = undefined;
    running = true;
    const v = core.video();
    surface.resize(v.width, v.height);
    present();
    if (hasAudio) audio.start(rate);
    return { ok: true, frame: core.frame(), adapter: adapter.id };
  }

  async function handle(m) {
    if (m.op === 'load') return load(m);
    if (m.op === 'controls') {
      return { ok: true, source: padId ? 'gamepad' : 'keyboard', gamepad: padId, labels: adapter ? legendFor(adapter) : [] };
    }
    if (!core) return { ok: false, error: 'no game loaded' };
    switch (m.op) {
      case 'press':
        try { await press(m.steps || []); } catch (err) { return { ok: false, error: String(err.message) }; }
        return { ok: true, frame: core.frame() };
      case 'screenshot': {
        const v = core.video();
        const png = await surface.png(v.rgba, v.width, v.height);
        return { ok: true, frame: core.frame(), png };
      }
      case 'save_state': {
        const s = core.saveState();
        return s ? { ok: true, state: s.slice().buffer } : { ok: false, error: 'the core could not save a state' };
      }
      case 'load_state':
        return { ok: core.loadState(new Uint8Array(m.state)), frame: core.frame() };
      case 'read':
        return { ok: true, bytes: Array.from(core.read(m.addr >>> 0, Math.min(m.len || 1, MAX_READ))) };
      case 'pause':
        running = !m.paused;
        return { ok: true, running };
      case 'mute':
        muted = !!m.muted;
        return { ok: true, muted };
      case 'status':
        return { ok: true, adapter: adapter.id, frame: core.frame(), running, keys: mask() };
      default:
        return { ok: false, error: `unknown op ${m.op}` };
    }
  }

  /** One rAF/timer tick: run the frames the clock owes (at most MAX_CATCHUP), then present once. */
  function tick(t) {
    if (!running || !core) return;
    const dt = last === undefined ? frameMs : Math.min(t - last, MAX_STEP_MS);
    last = t;
    const r = advance(acc, dt, frameMs, MAX_CATCHUP);
    acc = r.acc;
    if (r.frames) { stepFrames(r.frames); present(); }
  }

  function keyDown(code) {
    const name = keyName(adapter?.controls, code);
    if (!name) return false;
    keyMask |= bitOf(name);
    return true;
  }

  /** Button name a key maps to on this adapter (for evidence), or null. */
  function mappedName(code) {
    return keyName(adapter?.controls, code);
  }

  function keyUp(code) {
    const name = keyName(adapter?.controls, code);
    if (!name) return false;
    keyMask &= ~bitOf(name);
    return true;
  }

  function setPads(pads) {
    const gp = (pads || []).find(p => p.mapping === 'standard') || null;
    padId = gp ? gp.id : null;
    padMask = adapter && gp ? maskFor(adapter.buttons, padNames(adapter.buttons, gp)) : 0;
  }

  return {
    handle,
    tick,
    keyDown,
    keyUp,
    mappedName,
    setPads,
    blur() { keyMask = 0; },
    activeMask: mask,
    isRunning: () => running,
  };
}
