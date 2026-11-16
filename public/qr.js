/* QR codes drawn in the browser, with no outside service. Byte mode, error
 * correction level M, versions 1-6 (up to 106 bytes), which covers a report URL.
 * Follows ISO/IEC 18004 as laid out in Project Nayuki's reference encoder. */
const VinQr = (() => {
  // Level M only. Index = version.
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16];
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4];
  const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

  const rawModules = v => { let n = (16 * v + 128) * v + 64; if (v >= 2) { const a = Math.floor(v / 7) + 2; n -= (25 * a - 10) * a - 55; } return n; };
  const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v];

  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
    for (let i = 0; i < degree; i++) { for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
    return r;
  }
  function rsRemainder(data, divisor) {
    const r = divisor.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
    return r;
  }

  function utf8(text) {
    const out = [];
    for (const ch of String(text)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return out;
  }

  function codewords(bytes, version) {
    const capacity = dataCodewords(version), bits = [];
    const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(4, 4); push(bytes.length, 8); bytes.forEach(b => push(b, 8));
    push(0, Math.min(4, capacity * 8 - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
    for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
    // Split into blocks, add error correction, interleave.
    const nBlocks = BLOCKS[version], eccLen = ECC_PER_BLOCK[version], raw = Math.floor(rawModules(version) / 8);
    const shortBlocks = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks), divisor = rsDivisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < nBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += dat.length;
      const ecc = rsRemainder(dat, divisor); if (i < shortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(b[i]); });
    return out;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];

  function build(version, data, mask) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
    const pos = ALIGN[version];
    pos.forEach((ay, i) => pos.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    // Format bits: level M (00) and the mask, BCH-protected, both copies; then the dark module.
    let rem = mask; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((mask << 10) | rem) ^ 0x5412, bit = i => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
    // Data in the zigzag order, then the mask over non-function modules.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && i < data.length * 8) { m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    return m;
  }

  // Standard penalty rules; the lowest-scoring mask is used.
  function penalty(m) {
    const size = m.length; let score = 0, dark = 0;
    const lines = [];
    for (let a = 0; a < size; a++) { lines.push(m[a]); lines.push(m.map(row => row[a])); }
    for (const line of lines) {
      for (let k = 0; k < size;) { let e = k; while (e < size && line[e] === line[k]) e++; if (e - k >= 5) score += 3 + (e - k - 5); k = e; }
      const s = line.map(v => v ? 1 : 0).join('');
      for (const p of ['10111010000', '00001011101']) for (let k = s.indexOf(p); k !== -1; k = s.indexOf(p, k + 1)) score += 40;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
    m.forEach(row => row.forEach(v => { if (v) dark++; }));
    return score + 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size));
  }

  /** Boolean module matrix (true = dark), smallest version that fits; `mask` forces a mask pattern. */
  function matrix(text, { mask } = {}) {
    const bytes = utf8(text);
    let version = 1;
    while (version <= 6 && bytes.length + 2 > dataCodewords(version)) version++;
    if (version > 6) throw new Error('Text too long for this QR encoder');
    const data = codewords(bytes, version);
    if (mask !== undefined) return build(version, data, mask);
    let best = null, bestScore = Infinity;
    for (let k = 0; k < 8; k++) { const candidate = build(version, data, k), s = penalty(candidate); if (s < bestScore) { best = candidate; bestScore = s; } }
    return best;
  }

  const escAttr = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  /** Inline SVG with a four-module quiet zone; one path, crisp edges, labelled for screen readers. */
  function svg(text, label) {
    const m = matrix(text), size = m.length, q = 4, d = [];
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d.push(`M${x + q} ${y + q}h1v1h-1z`); }));
    return `<svg class="qr-code" viewBox="0 0 ${size + 2 * q} ${size + 2 * q}" role="img" aria-label="${escAttr(label || 'QR code: ' + text)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d.join('')}" fill="#000"/></svg>`;
  }

  return { matrix, svg };
})();
if (typeof window !== 'undefined') window.VinQr = VinQr;
