/* hermes-emulator-catalog: minimal WebAssembly front end over mGBA's core (libmgba).
 *
 * Built from unmodified upstream mGBA (https://github.com/mgba-emu/mgba, MPL-2.0) with
 * DISABLE_THREADING, so it runs in an opaque-origin sandboxed iframe with no
 * SharedArrayBuffer / cross-origin isolation.
 *
 * JS drives the loop: it calls hm_run_frame() at 60 Hz, blits hm_video_ptr(), feeds audio.
 * All state lives in this single translation unit; one core per module instance.
 */
#include <mgba/core/core.h>
#include <mgba/core/serialize.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/vfs.h>

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define AUDIO_SAMPLES 2048

static struct mCore* core;
static mColor* video;
static unsigned vw, vh;
static void* rom_copy;      /* VFileFromMemory does not own; keep the bytes alive */
static int16_t audio_out[AUDIO_SAMPLES * 2];

static void _teardown(void) {
	if (core) {
		core->deinit(core);
		core = NULL;
	}
	free(video);
	video = NULL;
	free(rom_copy);
	rom_copy = NULL;
}

/* Load a ROM image (raw .gba/.gb/.gbc bytes). Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE int hm_load(const uint8_t* data, size_t size) {
	_teardown();
	rom_copy = malloc(size);
	if (!rom_copy) {
		return 0;
	}
	memcpy(rom_copy, data, size);
	struct VFile* vf = VFileFromMemory(rom_copy, size);
	if (!vf) {
		return 0;
	}
	core = mCoreFindVF(vf);
	if (!core || !core->init(core)) {
		vf->close(vf);
		core = NULL;
		return 0;
	}
	mCoreInitConfig(core, NULL);
	core->baseVideoSize(core, &vw, &vh);
	video = calloc((size_t) vw * vh, sizeof(mColor));
	core->setVideoBuffer(core, video, vw);
	core->setAudioBufferSize(core, AUDIO_SAMPLES);
	if (!core->loadROM(core, vf)) {
		_teardown();
		return 0;
	}
	/* In-memory battery save so games that probe SRAM behave; persisted via hm_sram_*. */
	core->loadSave(core, VFileMemChunk(NULL, 0));
	core->reset(core);
	return 1;
}

EMSCRIPTEN_KEEPALIVE void hm_run_frame(void) {
	if (core) {
		core->runFrame(core);
	}
}

/* Bitmask of GBA keys: A=0 B=1 SELECT=2 START=3 RIGHT=4 LEFT=5 UP=6 DOWN=7 R=8 L=9. */
EMSCRIPTEN_KEEPALIVE void hm_set_keys(uint32_t keys) {
	if (core) {
		core->setKeys(core, keys);
	}
}

EMSCRIPTEN_KEEPALIVE mColor* hm_video_ptr(void) { return video; }
EMSCRIPTEN_KEEPALIVE unsigned hm_video_width(void) {
	if (core) {
		core->currentVideoSize(core, &vw, &vh);
	}
	return vw;
}
EMSCRIPTEN_KEEPALIVE unsigned hm_video_height(void) { return vh; }
EMSCRIPTEN_KEEPALIVE unsigned hm_video_stride(void) {
	unsigned bw = 0, bh = 0;
	if (core) {
		core->baseVideoSize(core, &bw, &bh);
	}
	return bw;
}
EMSCRIPTEN_KEEPALIVE uint32_t hm_frame(void) { return core ? core->frameCounter(core) : 0; }
EMSCRIPTEN_KEEPALIVE unsigned hm_sample_rate(void) { return core ? core->audioSampleRate(core) : 0; }
EMSCRIPTEN_KEEPALIVE int hm_bytes_per_pixel(void) { return (int) sizeof(mColor); }

/* Drain up to AUDIO_SAMPLES interleaved stereo frames; returns frame count. */
EMSCRIPTEN_KEEPALIVE size_t hm_audio_read(void) {
	if (!core) {
		return 0;
	}
	struct mAudioBuffer* buf = core->getAudioBuffer(core);
	size_t avail = mAudioBufferAvailable(buf);
	if (avail > AUDIO_SAMPLES) {
		avail = AUDIO_SAMPLES;
	}
	return mAudioBufferRead(buf, audio_out, avail);
}
EMSCRIPTEN_KEEPALIVE int16_t* hm_audio_ptr(void) { return audio_out; }

/* Save states: caller allocates hm_state_size() bytes. */
EMSCRIPTEN_KEEPALIVE size_t hm_state_size(void) { return core ? core->stateSize(core) : 0; }
EMSCRIPTEN_KEEPALIVE int hm_state_save(void* out) { return core && core->saveState(core, out); }
EMSCRIPTEN_KEEPALIVE int hm_state_load(const void* in) { return core && core->loadState(core, in); }

/* Memory peek for the agent (system bus, no side effects on rawRead). */
EMSCRIPTEN_KEEPALIVE uint32_t hm_read8(uint32_t address) { return core ? core->rawRead8(core, address, -1) : 0; }

EMSCRIPTEN_KEEPALIVE void hm_unload(void) { _teardown(); }
