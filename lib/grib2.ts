// A minimal GRIB2 decoder for exactly what HRRR composite reflectivity (REFC)
// needs: grid definition template 3.30 (Lambert Conformal) + data representation
// template 5.3 (complex packing + spatial differencing). Pure TS — no WASM, no
// JPEG2000 — so it runs in a Cloudflare Worker. Faithful port of NCEP g2c's
// `comunpack` for the 5.3 path.

/** Lambert-Conformal grid geometry (from §3 template 3.30). Angles in degrees,
 *  grid spacing in metres. */
export interface LccGrid {
  nx: number;
  ny: number;
  la1: number; // lat of first grid point
  lo1: number; // lon of first grid point (0–360)
  lov: number; // orientation / central meridian
  lad: number; // latitude where dx/dy are true
  dx: number; // metres
  dy: number; // metres
  latin1: number;
  latin2: number;
  scanMode: number;
}

export interface Grib2Field {
  grid: LccGrid;
  /** Decoded values (dBZ for REFC), row-major, length nx*ny. */
  values: Float32Array;
}

// ── bit + int helpers ────────────────────────────────────────────────────────

function u16(d: Uint8Array, o: number): number { return (d[o] << 8) | d[o + 1]; }
function u32(d: Uint8Array, o: number): number { return (d[o] * 0x1000000) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]; }
/** GRIB signed int: high bit is the sign, remaining bits the magnitude. */
function s16(d: Uint8Array, o: number): number { const v = u16(d, o); return v & 0x8000 ? -(v & 0x7fff) : v; }
function s32(d: Uint8Array, o: number): number { const v = u32(d, o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; }
/** IEEE-754 float32, big-endian. */
function f32(d: Uint8Array, o: number): number { return new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0, false); }

/** MSB-first bit reader over a byte array. */
class BitReader {
  private d: Uint8Array;
  private byte: number;
  private bit = 0;
  constructor(d: Uint8Array, startByte: number) { this.d = d; this.byte = startByte; }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((this.d[this.byte] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.byte++; }
    }
    return v;
  }
  /** Read `count` unsigned ints of `n` bits into `out`. n===0 → all zero. */
  readArray(n: number, count: number, out: Int32Array, at: number): void {
    if (n === 0) { for (let i = 0; i < count; i++) out[at + i] = 0; return; }
    for (let i = 0; i < count; i++) out[at + i] = this.read(n);
  }
  /** Advance to the next byte boundary. */
  align(): void { if (this.bit !== 0) { this.bit = 0; this.byte++; } }
}

// ── decoder ──────────────────────────────────────────────────────────────────

/** Decode a single-message GRIB2 buffer carrying an HRRR REFC field. */
export function decodeGrib2(buf: Uint8Array): Grib2Field {
  if (buf[0] !== 0x47 || buf[1] !== 0x52 || buf[2] !== 0x49 || buf[3] !== 0x42) {
    throw new Error("not GRIB2");
  }
  let grid: LccGrid | null = null;
  let drt: number[] | null = null; // §5 template values (parsed positionally)
  let R = 0, E = 0, D = 0, nbits = 0, order = 0, nds = 0, numpts = 0;
  let refGW = 0, nbitsGW = 0, refGL = 0, incGL = 0, lastGL = 0, nbitsGL = 0, NG = 0;
  let dataStart = -1;

  let i = 16; // after the 16-byte indicator section
  while (i < buf.length - 4) {
    if (buf[i] === 0x37 && buf[i + 1] === 0x37 && buf[i + 2] === 0x37 && buf[i + 3] === 0x37) break; // "7777"
    const secLen = u32(buf, i);
    const secNum = buf[i + 4];

    if (secNum === 3) {
      // Grid Definition Section. Template number at octets 13-14 (0-indexed i+12).
      const tmpl = u16(buf, i + 12);
      if (tmpl !== 30) throw new Error(`grid template ${tmpl} != 30 (LCC)`);
      const t = i + 14; // template body starts at octet 15 → i+14
      grid = {
        nx: u32(buf, t + 16),
        ny: u32(buf, t + 20),
        la1: s32(buf, t + 24) * 1e-6,
        lo1: u32(buf, t + 28) * 1e-6,
        lad: s32(buf, t + 33) * 1e-6,
        lov: u32(buf, t + 37) * 1e-6,
        dx: u32(buf, t + 41) / 1000, // mm → m
        dy: u32(buf, t + 45) / 1000,
        scanMode: buf[t + 50],
        latin1: s32(buf, t + 51) * 1e-6,
        latin2: s32(buf, t + 55) * 1e-6,
      };
    } else if (secNum === 5) {
      numpts = u32(buf, i + 5);
      const tmpl = u16(buf, i + 9);
      if (tmpl !== 3) throw new Error(`data template ${tmpl} != 3 (complex+spatial)`);
      const t = i + 11; // template 5.x body starts at octet 12 → i+11
      R = f32(buf, t + 0);
      E = s16(buf, t + 4);
      D = s16(buf, t + 6);
      nbits = buf[t + 8];
      // t+9 type, t+10 splitting, t+11 missing-mgmt, t+12..19 missing subs
      NG = u32(buf, t + 20);
      refGW = buf[t + 24];
      nbitsGW = buf[t + 25];
      refGL = u32(buf, t + 26);
      incGL = buf[t + 30];
      lastGL = u32(buf, t + 31);
      nbitsGL = buf[t + 35];
      order = buf[t + 36];      // octet 48
      nds = buf[t + 37];        // octet 49: bytes per extra descriptor
      drt = [R, E, D, nbits];
    } else if (secNum === 7) {
      dataStart = i + 5; // data begins at octet 6 of §7
    }
    i += secLen;
  }

  if (!grid || !drt || dataStart < 0) throw new Error("missing grid/data section");

  // ── §7: spatial-differencing extra descriptors, then complex-packed groups ──
  const br = new BitReader(buf, dataStart);
  const nbitsd = nds * 8;
  let ival1 = 0, ival2 = 0, minsd = 0;
  if (nbitsd > 0) {
    ival1 = br.read(nbitsd);
    if (order === 2) ival2 = br.read(nbitsd);
    const sign = br.read(1);
    minsd = br.read(nbitsd - 1);
    if (sign) minsd = -minsd;
  }

  // Group references, widths, lengths (three parallel arrays of length NG).
  const gref = new Int32Array(NG);
  const gwidth = new Int32Array(NG);
  const glen = new Int32Array(NG);
  // NCEP octet-pads each metadata sub-array: the group references, widths, and
  // lengths each start on a byte boundary. Reading them back-to-back as one
  // continuous bit stream only works when each array's bit length happens to be
  // a multiple of 8 — true for some runs (which is why a byte-aligned fixture
  // masked this), garbage for the rest, since the misaligned group lengths then
  // sum past `numpts` and the order-2 recurrence ramps into a runaway parabola.
  br.readArray(nbits, NG, gref, 0);
  br.align();
  br.readArray(nbitsGW, NG, gwidth, 0);
  br.align();
  for (let g = 0; g < NG; g++) gwidth[g] += refGW;
  br.readArray(nbitsGL, NG, glen, 0);
  br.align();
  for (let g = 0; g < NG; g++) glen[g] = glen[g] * incGL + refGL;
  glen[NG - 1] = lastGL;

  // Unpack each group's values: X = groupRef + packed(width bits).
  const X = new Int32Array(numpts);
  let n = 0;
  for (let g = 0; g < NG; g++) {
    const w = gwidth[g], len = glen[g], ref = gref[g];
    if (w === 0) {
      for (let k = 0; k < len && n < numpts; k++) X[n++] = ref;
    } else {
      for (let k = 0; k < len && n < numpts; k++) X[n++] = ref + br.read(w);
    }
  }

  // Reverse spatial differencing (order 1 or 2).
  if (order === 1) {
    X[0] = ival1;
    for (let m = 1; m < numpts; m++) { X[m] += minsd; X[m] += X[m - 1]; }
  } else if (order === 2) {
    X[0] = ival1; X[1] = ival2;
    for (let m = 2; m < numpts; m++) { X[m] += minsd; X[m] += 2 * X[m - 1] - X[m - 2]; }
  }

  // Scale: value = (R + X * 2^E) / 10^D.
  const twoE = Math.pow(2, E);
  const tenD = Math.pow(10, D);
  const values = new Float32Array(numpts);
  for (let m = 0; m < numpts; m++) values[m] = (R + X[m] * twoE) / tenD;

  return { grid, values };
}
