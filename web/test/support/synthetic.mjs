// Synthetic GBA images, built in code. No game data, no files.
//
// mGBA's detector (src/gba/gba.c GBAIsROM) needs 0xEA at offset 3 (an ARM branch) AND the fixed 0x96 at 0xB2.
// A 0xC0 image with only the 0x96 is rejected.

const u32le = (buf, at, v) => { buf[at] = v & 0xff; buf[at + 1] = (v >>> 8) & 0xff; buf[at + 2] = (v >>> 16) & 0xff; buf[at + 3] = (v >>> 24) & 0xff; };

// The minimum that mGBA detects as a GBA ROM.
export function detectableRom(size = 0xC0) {
  const rom = new Uint8Array(size);
  rom[3] = 0xEA;
  rom[0xB2] = 0x96;
  return rom;
}

// A program that switches to mode 3 with BG2 on and paints all 240x160 pixels one colour (BGR555 0x001F), then halts.
// Entry: word 0 is `B 0x080000C0` (0xEA00002E). The program sits at 0xC0.
export function paintRom() {
  const words = [
    0xE3A00404, // MOV r0,#0x04000000   DISPCNT
    0xE3A01003, // MOV r1,#3            mode 3
    0xE3811B01, // ORR r1,r1,#0x400     BG2 on
    0xE1C010B0, // STRH r1,[r0]
    0xE3A02406, // MOV r2,#0x06000000   VRAM
    0xE3A0301F, // MOV r3,#0x1F         red
    0xE3A04C96, // MOV r4,#0x9600       240*160 pixels
    0xE0C230B2, // loop: STRH r3,[r2],#2
    0xE2544001, // SUBS r4,r4,#1
    0x1AFFFFFC, // BNE loop
    0xEAFFFFFE, // halt: B halt
  ];
  const rom = new Uint8Array(0x200);
  u32le(rom, 0, 0xEA00002E);
  rom[0xB2] = 0x96;
  words.forEach((w, i) => u32le(rom, 0xC0 + i * 4, w));
  return rom;
}
