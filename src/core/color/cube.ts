export interface CubeLut {
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** size^3 RGB triplets, red changing fastest (Adobe .cube order). */
  data: Float32Array;
}

/** Parse an Adobe/Resolve `.cube` 3D LUT. 1D LUTs are rejected. */
export function parseCube(text: string): CubeLut {
  let title = 'LUT';
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE/i.test(line)) {
      title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, '');
    } else if (/^LUT_3D_SIZE/i.test(line)) {
      size = parseInt(line.split(/\s+/)[1], 10);
    } else if (/^LUT_1D_SIZE/i.test(line)) {
      throw new Error('1D LUTs are not supported');
    } else if (/^DOMAIN_MIN/i.test(line)) {
      domainMin = line.split(/\s+/).slice(1, 4).map(Number) as [number, number, number];
    } else if (/^DOMAIN_MAX/i.test(line)) {
      domainMax = line.split(/\s+/).slice(1, 4).map(Number) as [number, number, number];
    } else if (/^[-+\d.]/.test(line)) {
      const parts = line.split(/\s+/);
      values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  if (size < 2 || size > 128) throw new Error('Invalid LUT_3D_SIZE');
  if (values.length !== size * size * size * 3) throw new Error('LUT data size mismatch');
  return { title, size, domainMin, domainMax, data: Float32Array.from(values) };
}

/**
 * Lay the cube out as a 2D strip of `size` slices along X (width = size², height = size),
 * slice index = blue. The shader interpolates between two slices for trilinear sampling.
 */
export function cubeToStrip(lut: CubeLut): { width: number; height: number; pixels: Uint8Array } {
  const n = lut.size;
  const width = n * n;
  const pixels = new Uint8Array(width * n * 4);
  const [minR, minG, minB] = lut.domainMin;
  const [maxR, maxG, maxB] = lut.domainMax;
  const norm = (v: number, lo: number, hi: number) => Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const src = (b * n * n + g * n + r) * 3;
        const x = b * n + r;
        const y = g;
        const dst = (y * width + x) * 4;
        pixels[dst] = norm(lut.data[src], minR, maxR);
        pixels[dst + 1] = norm(lut.data[src + 1], minG, maxG);
        pixels[dst + 2] = norm(lut.data[src + 2], minB, maxB);
        pixels[dst + 3] = 255;
      }
    }
  }
  return { width, height: n, pixels };
}

/** Identity lattice laid out like `cubeToStrip`: width n², height n, x = b·n + r, y = g. */
export function identityStrip(n: number): Uint8Array {
  const w = n * n;
  const px = new Uint8Array(w * n * 4);
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const i = (g * w + b * n + r) * 4;
        px[i] = Math.round((r / (n - 1)) * 255);
        px[i + 1] = Math.round((g / (n - 1)) * 255);
        px[i + 2] = Math.round((b / (n - 1)) * 255);
        px[i + 3] = 255;
      }
  return px;
}

/** Writes an Adobe .cube from the rendered strip's 16-bit planes (high and low bytes). */
export function stripToCube(hi: Uint8Array, lo: Uint8Array, n: number, title: string): string {
  const w = n * n;
  const lines = [
    `TITLE "${title.replace(/"/g, "'")}"`,
    '# Created with Hikari',
    `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const v = (i: number) => ((hi[i] * 256 + lo[i]) / 65535).toFixed(6);
  // .cube order: red changes fastest, then green, then blue
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const i = (g * w + b * n + r) * 4;
        lines.push(`${v(i)} ${v(i + 1)} ${v(i + 2)}`);
      }
  return lines.join('\n') + '\n';
}
