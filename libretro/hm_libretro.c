/* hm_libretro.c: thin libretro frontend compiled to WebAssembly, core-agnostic.
 *
 * Link one libretro core (static .bc from its emscripten build) with this file to get a
 * per-core module. Same JS-facing hooks as web/src/hm_mgba.c where they apply:
 *   load(rom bytes), run(n), step(n) [works while paused], set_paused, set_buttons(mask),
 *   read(addr,len) [via SET_MEMORY_MAPS descriptors, bus addresses], memory(id) [via
 *   retro_get_memory_data], screenshot (RGBA8888), state_size/save/load, frame counter.
 *
 * Audio is accepted and discarded (spike scope). Input is a single joypad port 0 bitmask in
 * libretro RETRO_DEVICE_ID_JOYPAD_* bit positions.
 */
#include "libretro.h"

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_DESCS 64

/* ---- state ---- */
static uint32_t buttons;
static int paused;
static uint32_t frames;
static int game_loaded;

static enum retro_pixel_format pix_fmt = RETRO_PIXEL_FORMAT_0RGB1555;
static unsigned fb_w, fb_h, fb_pitch;
static uint8_t* fb;          /* last raw frame copied from video_refresh */
static size_t fb_cap;
static int fb_valid;
static uint32_t video_calls;
static uint32_t video_null_calls;

static struct retro_memory_descriptor descs[MAX_DESCS];
static unsigned n_descs;

static void* rom_copy;
static uint32_t core_fps_x1000;
static uint32_t core_rate;

/* ---- core symbols (provided by the linked core) ---- */
void retro_init(void);
void retro_deinit(void);
unsigned retro_api_version(void);
void retro_set_environment(retro_environment_t);
void retro_set_video_refresh(retro_video_refresh_t);
void retro_set_audio_sample(retro_audio_sample_t);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t);
void retro_set_input_poll(retro_input_poll_t);
void retro_set_input_state(retro_input_state_t);
void retro_get_system_info(struct retro_system_info*);
void retro_get_system_av_info(struct retro_system_av_info*);
bool retro_load_game(const struct retro_game_info*);
void retro_unload_game(void);
void retro_run(void);
void retro_reset(void);
size_t retro_serialize_size(void);
bool retro_serialize(void* data, size_t size);
bool retro_unserialize(const void* data, size_t size);
void* retro_get_memory_data(unsigned id);
size_t retro_get_memory_size(unsigned id);

/* ---- frontend callbacks ---- */
static bool on_environment(unsigned cmd, void* data) {
	switch (cmd & 0xFFFF) { /* strip RETRO_ENVIRONMENT_EXPERIMENTAL */
	case (RETRO_ENVIRONMENT_GET_CAN_DUPE & 0xFFFF):
		*(bool*) data = true;
		return true;
	case (RETRO_ENVIRONMENT_SET_PIXEL_FORMAT & 0xFFFF): {
		enum retro_pixel_format f = *(const enum retro_pixel_format*) data;
		if (f != RETRO_PIXEL_FORMAT_0RGB1555 && f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565) {
			return false;
		}
		pix_fmt = f;
		return true;
	}
	case (RETRO_ENVIRONMENT_SET_MEMORY_MAPS & 0xFFFF): {
		const struct retro_memory_map* m = data;
		n_descs = m->num_descriptors > MAX_DESCS ? MAX_DESCS : m->num_descriptors;
		memcpy(descs, m->descriptors, n_descs * sizeof(descs[0]));
		return true;
	}
	case (RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO & 0xFFFF): {
		const struct retro_system_av_info* av = data;
		core_fps_x1000 = (uint32_t) (av->timing.fps * 1000.0);
		core_rate = (uint32_t) av->timing.sample_rate;
		return true;
	}
	case (RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE & 0xFFFF): {
		/* Cores read this into an uninitialised local when unanswered (QuickNES does), so
		 * answer explicitly: bit0 video on, bit1 audio on. */
		*(int*) data = 3;
		return true;
	}
	case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
	case (RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS & 0xFFFF):
	case (RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS & 0xFFFF):
	case (RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY & 0xFFFF):
	case (RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK & 0xFFFF):
	case (RETRO_ENVIRONMENT_SET_CONTROLLER_INFO & 0xFFFF):
	case (RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK & 0xFFFF):
		return true;
	default:
		/* GET_VARIABLE, GET_SYSTEM_DIRECTORY, GET_LOG_INTERFACE, GET_INPUT_BITMASKS, ...:
		 * report unsupported so the core falls back to defaults. */
		return false;
	}
}

static void on_video(const void* data, unsigned w, unsigned h, size_t pitch) {
	if (!data) {
		video_null_calls++;
		return; /* frame duplicate: keep the previous frame */
	}
	video_calls++;
	size_t bpp = pix_fmt == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
	size_t need = (size_t) pitch * h;
	if (need > fb_cap) {
		free(fb);
		fb = malloc(need);
		fb_cap = need;
	}
	memcpy(fb, data, need);
	fb_w = w;
	fb_h = h;
	fb_pitch = (unsigned) pitch;
	fb_valid = 1;
	(void) bpp;
}

/* ---- audio ring: interleaved s16 stereo frames, drop-oldest when full (bounded latency) ---- */
#define AUDIO_RING_FRAMES (1u << 16)
static int16_t audio_ring[AUDIO_RING_FRAMES * 2];
static uint32_t audio_head;   /* next write frame (monotonic, masked on use) */
static uint32_t audio_tail;   /* next read frame (monotonic) */

static void audio_push(const int16_t* stereo, size_t n_frames) {
	for (size_t i = 0; i < n_frames; i++) {
		uint32_t slot = (audio_head & (AUDIO_RING_FRAMES - 1)) * 2;
		audio_ring[slot] = stereo[i * 2];
		audio_ring[slot + 1] = stereo[i * 2 + 1];
		audio_head++;
		if (audio_head - audio_tail > AUDIO_RING_FRAMES) {
			audio_tail = audio_head - AUDIO_RING_FRAMES; /* overwrite oldest */
		}
	}
}

static void on_audio(int16_t l, int16_t r) {
	int16_t s[2] = { l, r };
	audio_push(s, 1);
}

/* Cores return the number of frames consumed; the ring always takes them all. */
static size_t on_audio_batch(const int16_t* d, size_t frames_n) {
	audio_push(d, frames_n);
	return frames_n;
}
static void on_poll(void) {}
static int16_t on_input(unsigned port, unsigned device, unsigned index, unsigned id) {
	(void) index;
	if (port != 0 || device != RETRO_DEVICE_JOYPAD) {
		return 0;
	}
	if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
		return (int16_t) buttons;
	}
	return (int16_t) ((buttons >> id) & 1);
}

/* ---- exported to JS ---- */
EMSCRIPTEN_KEEPALIVE int hm_lr_init(void) {
	retro_set_environment(on_environment);
	retro_set_video_refresh(on_video);
	retro_set_audio_sample(on_audio);
	retro_set_audio_sample_batch(on_audio_batch);
	retro_set_input_poll(on_poll);
	retro_set_input_state(on_input);
	retro_init();
	return 1;
}

EMSCRIPTEN_KEEPALIVE int hm_lr_load(const uint8_t* data, size_t size) {
	if (game_loaded) {
		retro_unload_game();
		game_loaded = 0;
	}
	free(rom_copy);
	rom_copy = malloc(size);
	if (!rom_copy) {
		return 0;
	}
	memcpy(rom_copy, data, size);
	struct retro_game_info gi = { NULL, rom_copy, size, NULL };
	if (!retro_load_game(&gi)) {
		return 0;
	}
	game_loaded = 1;
	frames = 0;
	fb_valid = 0;
	audio_head = 0;   /* drop audio left over from the previous game */
	audio_tail = 0;
	/* libretro: the frontend asks for timing after load. Cores are not required to send
	 * SET_SYSTEM_AV_INFO, so without this fps and sample rate stay 0 (QuickNES does not send it). */
	struct retro_system_av_info av;
	memset(&av, 0, sizeof(av));
	retro_get_system_av_info(&av);
	core_fps_x1000 = (uint32_t) (av.timing.fps * 1000.0);
	core_rate = (uint32_t) av.timing.sample_rate;
	return 1;
}

EMSCRIPTEN_KEEPALIVE void hm_lr_set_buttons(uint32_t mask) { buttons = mask; }
EMSCRIPTEN_KEEPALIVE void hm_lr_set_paused(int p) { paused = p ? 1 : 0; }

/* Advance n frames regardless of pause (frame-exact stepping). */
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_step(uint32_t n) {
	for (uint32_t i = 0; i < n && game_loaded; i++) {
		retro_run();
		frames++;
	}
	return frames;
}

/* Run n frames unless paused; returns frames executed. */
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_run(uint32_t n) {
	if (paused) {
		return 0;
	}
	uint32_t before = frames;
	hm_lr_step(n);
	return frames - before;
}

EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_frame(void) { return frames; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_fps(void) { return core_fps_x1000; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_sample_rate(void) { return core_rate; }
EMSCRIPTEN_KEEPALIVE int hm_lr_pixel_format(void) { return (int) pix_fmt; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_video_width(void) { return fb_w; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_video_height(void) { return fb_h; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_video_calls(void) { return video_calls; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_video_null_calls(void) { return video_null_calls; }
/* Frames currently buffered (not yet drained by hm_lr_audio_read). */
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_audio_frames(void) { return audio_head - audio_tail; }
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_audio_rate(void) { return core_rate; }

/* Copy up to maxFrames buffered stereo frames into out (interleaved s16, 2 samples per frame).
 * Returns frames copied. Drains what it returns. */
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_audio_read(int16_t* out, uint32_t maxFrames) {
	uint32_t avail = audio_head - audio_tail;
	uint32_t n = avail < maxFrames ? avail : maxFrames;
	for (uint32_t i = 0; i < n; i++) {
		uint32_t slot = ((audio_tail + i) & (AUDIO_RING_FRAMES - 1)) * 2;
		out[i * 2] = audio_ring[slot];
		out[i * 2 + 1] = audio_ring[slot + 1];
	}
	audio_tail += n;
	return n;
}

/* Memory by libretro region id (RETRO_MEMORY_*). */
EMSCRIPTEN_KEEPALIVE size_t hm_lr_memory_size(unsigned id) { return retro_get_memory_size(id); }
EMSCRIPTEN_KEEPALIVE void* hm_lr_memory_data(unsigned id) { return retro_get_memory_data(id); }

/* Bus-address read through SET_MEMORY_MAPS descriptors (libretro spec matching rules:
 * (addr & select) == (start & select) when select is set, else plain range check). */
/* Spec: match when (addr & select) == (start & select) (select==0: plain range), then
 * host = ptr + (addr & ~disconnect) - start. Mirrors are only resolved when the core sets
 * `disconnect`; mGBA does not for IWRAM/EWRAM, so mirrors above the first copy are unmapped. */
static int desc_byte(uint32_t addr, uint8_t* out) {
	for (unsigned i = 0; i < n_descs; i++) {
		const struct retro_memory_descriptor* d = &descs[i];
		if (!d->ptr || !d->len) {
			continue;
		}
		uint64_t a = addr;
		if (d->select) {
			if ((a & d->select) != ((uint64_t) d->start & d->select)) {
				continue;
			}
		} else if (a < d->start) {
			continue;
		}
		uint64_t off = (a & ~(uint64_t) d->disconnect) - (uint64_t) d->start;
		if (off >= d->len) {
			continue;
		}
		*out = ((uint8_t*) d->ptr)[d->offset + off];
		return 1;
	}
	return 0;
}

/* Returns len on success (every byte mapped), or -1 if any byte is unmapped. */
EMSCRIPTEN_KEEPALIVE int hm_lr_read(uint32_t addr, uint32_t len, uint8_t* out) {
	for (uint32_t i = 0; i < len; i++) {
		if (!desc_byte(addr + i, &out[i])) {
			return -1;
		}
	}
	return (int) len;
}

/* RGBA8888 screenshot of the last frame; returns bytes written, 0 if none yet. */
EMSCRIPTEN_KEEPALIVE uint32_t hm_lr_screenshot_rgba(uint8_t* out, uint32_t cap) {
	if (!fb_valid) {
		return 0;
	}
	uint32_t need = fb_w * fb_h * 4;
	if (cap < need) {
		return 0;
	}
	for (unsigned y = 0; y < fb_h; y++) {
		const uint8_t* row = fb + (size_t) y * fb_pitch;
		uint8_t* o = out + (size_t) y * fb_w * 4;
		for (unsigned x = 0; x < fb_w; x++) {
			uint8_t r, g, b;
			if (pix_fmt == RETRO_PIXEL_FORMAT_XRGB8888) {
				const uint8_t* p = row + x * 4; /* little-endian XRGB: B G R X */
				b = p[0]; g = p[1]; r = p[2];
			} else if (pix_fmt == RETRO_PIXEL_FORMAT_RGB565) {
				uint16_t v = (uint16_t) (row[x * 2] | (row[x * 2 + 1] << 8));
				r = (uint8_t) (((v >> 11) & 31) * 255 / 31);
				g = (uint8_t) (((v >> 5) & 63) * 255 / 63);
				b = (uint8_t) ((v & 31) * 255 / 31);
			} else {
				uint16_t v = (uint16_t) (row[x * 2] | (row[x * 2 + 1] << 8));
				r = (uint8_t) (((v >> 10) & 31) * 255 / 31);
				g = (uint8_t) (((v >> 5) & 31) * 255 / 31);
				b = (uint8_t) ((v & 31) * 255 / 31);
			}
			o[x * 4] = r; o[x * 4 + 1] = g; o[x * 4 + 2] = b; o[x * 4 + 3] = 255;
		}
	}
	return need;
}

EMSCRIPTEN_KEEPALIVE size_t hm_lr_state_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int hm_lr_state_save(void* out, size_t size) { return retro_serialize(out, size) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int hm_lr_state_load(const void* in, size_t size) { return retro_unserialize(in, size) ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE void hm_lr_unload(void) {
	if (game_loaded) {
		retro_unload_game();
		game_loaded = 0;
	}
	retro_deinit();
}
