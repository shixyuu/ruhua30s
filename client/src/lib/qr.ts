/**
 * Minimalist zero-dependency QR Code SVG generator (Byte mode, ECC-L, Versions 1–6).
 * Enough for URLs up to ~134 bytes (e.g. https://domain.com/upload).
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsPoly(deg: number): Uint8Array {
  let p = new Uint8Array([1]);
  for (let i = 0; i < deg; i++) {
    const next = new Uint8Array(p.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < p.length; j++) {
      next[j] ^= p[j];
      next[j + 1] ^= gfMul(p[j], factor);
    }
    p = next;
  }
  return p;
}

function rsEcc(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsPoly(eccLen);
  const res = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j++) {
      res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

// [version]: [size, totalDataBytes, eccBytesPerBlock, alignPos[]] (ECC Level L, 1 block for v1-v5, 2 blocks for v6)
const VER_SPEC: Record<number, { size: number; dataBytes: number; eccBytes: number; blocks: number; align: number[] }> = {
  1: { size: 21, dataBytes: 19, eccBytes: 7, blocks: 1, align: [] },
  2: { size: 25, dataBytes: 34, eccBytes: 10, blocks: 1, align: [6, 18] },
  3: { size: 29, dataBytes: 55, eccBytes: 15, blocks: 1, align: [6, 22] },
  4: { size: 33, dataBytes: 80, eccBytes: 20, blocks: 1, align: [6, 26] },
  5: { size: 37, dataBytes: 108, eccBytes: 26, blocks: 1, align: [6, 30] },
  6: { size: 41, dataBytes: 136, eccBytes: 18, blocks: 2, align: [6, 34] },
};

export function generateQrSvg(text: string, fg = '#E8E2D5', bg = '#080706'): string {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (ver < 6 && bytes.length + 2 > VER_SPEC[ver].dataBytes) ver++;
  const spec = VER_SPEC[ver];
  const size = spec.size;

  // Bit stream: 0100 (Byte mode) + 8-bit length + bytes + terminator + padding
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = spec.dataBytes * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  let padByte = 0xec;
  while (bits.length < maxBits) {
    pushBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const dataBytes = new Uint8Array(spec.dataBytes);
  for (let i = 0; i < spec.dataBytes; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataBytes[i] = v;
  }

  // Split into blocks & interleave
  const blockSize = Math.floor(spec.dataBytes / spec.blocks);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let b = 0; b < spec.blocks; b++) {
    const slice = dataBytes.subarray(b * blockSize, (b + 1) * blockSize);
    dataBlocks.push(slice);
    eccBlocks.push(rsEcc(slice, spec.eccBytes));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blockSize; i++) for (const db of dataBlocks) codewords.push(db[i]);
  for (let i = 0; i < spec.eccBytes; i++) for (const eb of eccBlocks) codewords.push(eb[i]);

  // Matrix: -1 = unset, 0 = light, 1 = dark; isFunc marks reserved modules
  const mod = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r: number, c: number, val: number) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = val;
    isFunc[r][c] = 1;
  };

  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inBox &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r, c, dark ? 1 : 0);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0 ? 1 : 0);
    setFunc(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns
  if (spec.align.length >= 2) {
    const pos = spec.align;
    for (const r of pos) {
      for (const c of pos) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setFunc(r + dr, c + dc, dark ? 1 : 0);
          }
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) {
    isFunc[8][i] = 1;
    isFunc[i][8] = 1;
  }
  setFunc(size - 8, 8, 1);

  // Place data bits (zigzag) + apply mask 0 ((r + c) % 2 === 0)
  const totalBits = codewords.length * 8;
  let bitIdx = 0;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let lr = 0; lr < 2; lr++) {
        const c = right - lr;
        if (isFunc[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        mod[r][c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0);
      }
    }
    up = !up;
  }

  // Write format info for ECC-L (01) + Mask 0 (000) -> 15-bit BCH: 111011111000100
  const fmt = 0b111011111000100;
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 6) mod[i][8] = bit;
    else if (i < 8) mod[i + 1][8] = bit;
    else mod[size - 15 + i][8] = bit;

    if (i < 8) mod[8][size - 1 - i] = bit;
    else if (i < 9) mod[8][7] = bit;
    else mod[8][14 - i] = bit;
  }

  const quiet = 2;
  const full = size + quiet * 2;
  let paths = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mod[r][c] === 1) {
        paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return `<svg viewBox="0 0 ${full} ${full}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="${bg}"/><path d="${paths}" fill="${fg}"/></svg>`;
}
