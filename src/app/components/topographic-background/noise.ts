/**
 * Seeded 2D simplex noise, based on Stefan Gustavson's public-domain
 * reference implementation. Output is continuous and roughly in [-1, 1].
 *
 * Kept dependency-free and allocation-free per call so it can be sampled
 * tens of thousands of times per frame.
 */
export type Noise2D = (x: number, y: number) => number;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Small, fast deterministic PRNG used to shuffle the permutation table. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNoise2D(seed = 1): Noise2D {
  const random = mulberry32(seed);

  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = source[i];
    source[i] = source[j];
    source[j] = tmp;
  }

  // Doubled tables avoid index wrapping in the hot path.
  const perm = new Uint8Array(512);
  const gradX = new Float64Array(512);
  const gradY = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = source[i & 255];
    const [gx, gy] = GRADIENTS[perm[i] & 7];
    gradX[i] = gx;
    gradY[i] = gy;
  }

  return (x: number, y: number): number => {
    // Skew input space to find the containing simplex cell.
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    // Which of the two triangles of the cell are we in?
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = ii + perm[jj];
      t0 *= t0;
      n += t0 * t0 * (gradX[g] * x0 + gradY[g] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = ii + i1 + perm[jj + j1];
      t1 *= t1;
      n += t1 * t1 * (gradX[g] * x1 + gradY[g] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = ii + 1 + perm[jj + 1];
      t2 *= t2;
      n += t2 * t2 * (gradX[g] * x2 + gradY[g] * y2);
    }

    return 70 * n;
  };
}
