// libretro/binding.mjs: the ONE CoreHandle binding for every libretro core (CONTRACTS §2, §11.3).
// Copied verbatim into each libretro adapter by build-core.sh, so adapters stay self-contained.
// Default export: bind(Module) -> CoreHandle. Maps the shared host's hm_lr_* exports onto the ABI.
// Every call re-reads M.HEAPU8: malloc can grow the heap and detach the old view.

const AUDIO_CHUNK_FRAMES = 4096;

export default function bind(M) {
  M._hm_lr_init(); // registers frontend callbacks + retro_init(); must precede load

  const alloc = n => M._malloc(Math.max(n, 1));
  const free = p => M._free(p);

  // Read a byte range through the core's memory maps. Unmapped bytes come back as zeros.
  function readMapped(addr, len) {
    const out = new Uint8Array(len);
    const p = alloc(len);
    try {
      if (M._hm_lr_read(addr >>> 0, len, p) === len) {
        out.set(M.HEAPU8.subarray(p, p + len));
        return out;
      }
    } finally {
      free(p);
    }
    // Some byte in the range is unmapped: resolve it byte by byte so the mapped bytes stay real.
    const one = alloc(1);
    try {
      for (let i = 0; i < len; i++) {
        out[i] = M._hm_lr_read((addr + i) >>> 0, 1, one) === 1 ? M.HEAPU8[one] : 0;
      }
    } finally {
      free(one);
    }
    return out;
  }

  const handle = {
    load(bytes) {
      const p = alloc(bytes.length);
      try {
        M.HEAPU8.set(bytes, p);
        return M._hm_lr_load(p, bytes.length) === 1;
      } finally {
        free(p);
      }
    },

    unload() {
      M._hm_lr_unload();
    },

    runFrame() {
      M._hm_lr_step(1);
    },

    frame() {
      return M._hm_lr_frame();
    },

    fps() {
      return M._hm_lr_fps() / 1000;
    },

    setButtons(mask) {
      M._hm_lr_set_buttons(mask >>> 0);
    },

    video() {
      const width = M._hm_lr_video_width();
      const height = M._hm_lr_video_height();
      const cap = width * height * 4;
      if (cap === 0) return { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
      const p = alloc(cap);
      try {
        const n = M._hm_lr_screenshot_rgba(p, cap);
        if (n !== cap) return { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
        return { width, height, rgba: new Uint8ClampedArray(M.HEAPU8.slice(p, p + cap)) };
      } finally {
        free(p);
      }
    },

    stateSize() {
      return M._hm_lr_state_size();
    },

    saveState() {
      const size = M._hm_lr_state_size();
      const p = alloc(size);
      try {
        if (M._hm_lr_state_save(p, size) !== 1) return null;
        return M.HEAPU8.slice(p, p + size);
      } finally {
        free(p);
      }
    },

    loadState(bytes) {
      const p = alloc(bytes.length);
      try {
        M.HEAPU8.set(bytes, p);
        return M._hm_lr_state_load(p, bytes.length) === 1;
      } finally {
        free(p);
      }
    },

    read(addr, len) {
      return readMapped(addr, len);
    },

    // Drain the host's audio ring: interleaved s16 stereo since the last call.
    audio() {
      const chunks = [];
      let total = 0;
      const p = alloc(AUDIO_CHUNK_FRAMES * 4);
      try {
        for (;;) {
          const n = M._hm_lr_audio_read(p, AUDIO_CHUNK_FRAMES);
          if (n === 0) break;
          chunks.push(new Int16Array(M.HEAPU8.slice(p, p + n * 4).buffer));
          total += n * 2;
        }
      } finally {
        free(p);
      }
      const out = new Int16Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    },
  };

  // Sample rate of the core's audio (Hz). A property, not a method: the ABI lists it as data.
  Object.defineProperty(handle, 'audioRate', { get: () => M._hm_lr_audio_rate(), enumerable: true });
  return handle;
}
