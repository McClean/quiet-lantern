// mGBA binding: maps the native hm_* exports of web/src/hm_mgba.c (built into core/mgba.wasm) to the Core ABI
// (the CoreHandle contract in web/engine/contracts.mjs). Default export bind(Module) -> CoreHandle. The engine and player only call the handle.
//
// Bit order: manifest.json `buttons` (GBA order), passed straight to hm_set_keys.
// Video: hm_video_ptr() is 4-byte mColor per pixel; the first three bytes are R, G, B (see player blit).

// GBA nominal refresh rate. hm_mgba.c does not export it, so the binding states it.
const GBA_FPS = 59.7275;
const AUDIO_CHANNELS = 2;

export default function bind(M) {
  // Re-read the heap views on every access: memory growth replaces the typed-array buffers.
  const heap8 = () => M.HEAPU8;
  const heap16 = () => M.HEAP16;

  function withBytes(bytes, fn) {
    const p = M._malloc(bytes.length);
    try {
      heap8().set(bytes, p);
      return fn(p);
    } finally {
      M._free(p);
    }
  }

  return {
    load(bytes) {
      return withBytes(bytes, p => !!M._hm_load(p, bytes.length));
    },
    unload() {
      M._hm_unload();
    },
    runFrame() {
      M._hm_run_frame();
    },
    frame() {
      return M._hm_frame();
    },
    fps() {
      return GBA_FPS;
    },
    setButtons(mask) {
      M._hm_set_keys(mask >>> 0);
    },
    video() {
      const width = M._hm_video_width();
      const height = M._hm_video_height();
      const stride = M._hm_video_stride();   // pixels per row in the core buffer (may exceed width)
      const base = M._hm_video_ptr();
      const src = heap8();
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        let s = base + y * stride * 4;
        let d = y * width * 4;
        for (let x = 0; x < width; x++, s += 4, d += 4) {
          rgba[d] = src[s];
          rgba[d + 1] = src[s + 1];
          rgba[d + 2] = src[s + 2];
          rgba[d + 3] = 255;
        }
      }
      return { width, height, rgba };
    },
    stateSize() {
      return M._hm_state_size();
    },
    saveState() {
      const n = M._hm_state_size();
      if (!n) return null;
      const p = M._malloc(n);
      try {
        const ok = M._hm_state_save(p);
        return ok ? heap8().slice(p, p + n) : null;
      } finally {
        M._free(p);
      }
    },
    loadState(bytes) {
      return withBytes(bytes, p => !!M._hm_state_load(p));
    },
    read(addr, len) {
      // No block export yet: hm_read8 returns 0 for addresses outside the memory map, which is the ABI rule.
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = M._hm_read8((addr + i) >>> 0) & 0xff;
      return out;
    },
    audio() {
      const frames = M._hm_audio_read();          // stereo frames drained since the last call
      if (!frames) return new Int16Array(0);
      const p = M._hm_audio_ptr() >> 1;           // byte pointer -> int16 index
      return heap16().slice(p, p + frames * AUDIO_CHANNELS);
    },
  };
}
