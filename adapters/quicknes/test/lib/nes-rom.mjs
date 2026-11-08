// Generates a tiny iNES (mapper 0, NROM-128, CHR-RAM) test ROM from source written here.
// No binary is committed; tests call buildNesRom() to get the bytes in memory.
// Builds a tiny synthetic NES ROM for tests (no game data).
//
// Behaviour (all of it observable from the host):
//  - $0200..$0201 hold the pattern A5 5A (visible via read_memory).
//  - $0011 holds the joypad state read from $4016 (NES bit order: A=0x80 B=0x40 Select=0x20
//    Start=0x10 Up=0x08 Down=0x04 Left=0x02 Right=0x01).
//  - $0012 is a frame counter incremented once per main-loop pass (once per vblank).
//  - Background palette entry $3F00 is $16 (red) while A is held, $0F (black) otherwise.

const ORG = 0xC000;

export function buildNesRom() {
  const prog = [];
  const labels = {};
  const fix = [];
  const emit = (...b) => { prog.push(...b); };
  const label = n => { labels[n] = prog.length; };
  const rel = (op, n) => { emit(op, 0); fix.push({ at: prog.length - 1, n, kind: 'rel' }); };
  const abs = (op, n) => { emit(op, 0, 0); fix.push({ at: prog.length - 2, n, kind: 'abs' }); };

  label('RESET');
  emit(0x78);                 // SEI
  emit(0xD8);                 // CLD
  emit(0xA2, 0xFF, 0x9A);     // LDX #$FF ; TXS
  emit(0xA9, 0x00, 0x8D, 0x00, 0x20); // LDA #0 ; STA $2000
  emit(0xA9, 0x00, 0x8D, 0x01, 0x20); // LDA #0 ; STA $2001
  label('VB1');
  emit(0x2C, 0x02, 0x20);     // BIT $2002
  rel(0x10, 'VB1');           // BPL VB1
  // background palette entry 0 = $0F
  emit(0xA9, 0x3F, 0x8D, 0x06, 0x20, 0xA9, 0x00, 0x8D, 0x06, 0x20, 0xA9, 0x0F, 0x8D, 0x07, 0x20);
  // pattern at $0200
  emit(0xA9, 0xA5, 0x8D, 0x00, 0x02, 0xA9, 0x5A, 0x8D, 0x01, 0x02);
  // Clear CHR-RAM tile 0 ($0000..$000F) and nametable 0 ($2000..$23FF) to zero. QuickNES fills
  // both with $FF at power-on, so without this every background pixel is colour 3 of sub-palette 3
  // and the backdrop $3F00 is never drawn. Done while rendering is still disabled.
  emit(0xA9, 0x00, 0x8D, 0x06, 0x20, 0xA9, 0x00, 0x8D, 0x06, 0x20); // PPUADDR = $0000
  emit(0xA2, 0x10);           // LDX #16
  label('CHR');
  emit(0xA9, 0x00, 0x8D, 0x07, 0x20, 0xCA); // LDA #0 ; STA $2007 ; DEX
  rel(0xD0, 'CHR');           // BNE CHR
  emit(0xA9, 0x20, 0x8D, 0x06, 0x20, 0xA9, 0x00, 0x8D, 0x06, 0x20); // PPUADDR = $2000
  emit(0xA2, 0x04);           // LDX #4 (4 x 256 = 1024 bytes)
  label('NTO');
  emit(0xA0, 0x00);           // LDY #0
  label('NTI');
  emit(0xA9, 0x00, 0x8D, 0x07, 0x20, 0x88); // LDA #0 ; STA $2007 ; DEY
  rel(0xD0, 'NTI');           // BNE NTI
  emit(0xCA);                 // DEX
  rel(0xD0, 'NTO');           // BNE NTO
  // enable background + sprites, left 8px
  emit(0xA9, 0x1E, 0x8D, 0x01, 0x20);
  // frame counter = 0
  emit(0xA9, 0x00, 0x85, 0x12);
  label('MAIN');
  emit(0x2C, 0x02, 0x20);     // BIT $2002  (wait for vblank: N flag)
  rel(0x10, 'MAIN');          // BPL MAIN
  // strobe controller 1, then read 8 bits into $11 (A ends up in bit 7)
  emit(0xA9, 0x01, 0x8D, 0x16, 0x40, 0xA9, 0x00, 0x8D, 0x16, 0x40);
  emit(0xA2, 0x08);           // LDX #8
  label('RD');
  emit(0xAD, 0x16, 0x40);     // LDA $4016
  emit(0x4A);                 // LSR A
  emit(0x26, 0x11);           // ROL $11
  emit(0xCA);                 // DEX
  rel(0xD0, 'RD');            // BNE RD
  // background colour from A button
  emit(0xA9, 0x3F, 0x8D, 0x06, 0x20, 0xA9, 0x00, 0x8D, 0x06, 0x20);
  emit(0xA5, 0x11, 0x29, 0x80); // LDA $11 ; AND #$80
  rel(0xF0, 'DARK');          // BEQ DARK
  emit(0xA9, 0x16);           // LDA #$16 (red)
  rel(0xD0, 'SET');           // BNE SET (always taken: Z clear)
  label('DARK');
  emit(0xA9, 0x0F);           // LDA #$0F (black)
  label('SET');
  emit(0x8D, 0x07, 0x20);     // STA $2007
  emit(0xE6, 0x12);           // INC $12
  abs(0x4C, 'MAIN');          // JMP MAIN
  label('NMI');
  emit(0x40);                 // RTI
  label('IRQ');
  emit(0x40);                 // RTI

  for (const f of fix) {
    if (!(f.n in labels)) throw new Error(`undefined label ${f.n}`);
    if (f.kind === 'rel') {
      const off = labels[f.n] - (f.at + 1);
      if (off < -128 || off > 127) throw new Error(`branch out of range to ${f.n}`);
      prog[f.at] = off & 0xFF;
    } else {
      const addr = ORG + labels[f.n];
      prog[f.at] = addr & 0xFF;
      prog[f.at + 1] = addr >> 8;
    }
  }

  const prg = new Uint8Array(16384);
  prg.set(prog, 0);
  // vectors at $FFFA/$FFFC/$FFFE -> PRG offset 0x3FFA..
  const vec = (name, off) => { const a = ORG + labels[name]; prg[off] = a & 0xFF; prg[off + 1] = a >> 8; };
  vec('NMI', 0x3FFA);
  vec('RESET', 0x3FFC);
  vec('IRQ', 0x3FFE);

  const header = new Uint8Array(16);
  header.set([0x4E, 0x45, 0x53, 0x1A, 1, 0, 0, 0]); // "NES" EOF, 1x16KB PRG, 0 CHR (=> CHR-RAM)
  const rom = new Uint8Array(16 + prg.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  return rom;
}

export const NES_LABELS = { RESET: ORG };
