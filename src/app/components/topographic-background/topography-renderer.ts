import { createNoise2D, Noise2D } from './noise';

/** Shape of the terrain. */
export interface TopographyOptions {
  /** Seed for the terrain noise; the same seed always yields the same landscape. */
  seed: number;
  /** Approximate size of the dominant landforms, in CSS pixels, at scale 1. */
  featureSize: number;
  /** Height difference between neighbouring contour lines (noise units). */
  contourInterval: number;
  /** Every n-th contour is an "index contour", drawn slightly brighter. */
  majorEvery: number;
}

/** Look of the contour lines. */
export interface TopographyStyle {
  /** Line colour as an `r, g, b` triplet, e.g. `"248, 239, 242"`. */
  rgb: string;
  minorAlpha: number;
  majorAlpha: number;
  /** Extra opacity added to lines right around the pointer. */
  highlightAlpha: number;
  minorWidth: number;
  majorWidth: number;
}

/** A soft, Gaussian-shaped deformation of the terrain around a point. */
export interface TerrainInfluence {
  x: number;
  y: number;
  /** 0 disables the influence, 1 is full strength. */
  strength: number;
  /** Characteristic radius (CSS px): ~40% strength here, fading to zero at 2× this distance. */
  radius: number;
}

// --- Terrain recipe --------------------------------------------------------
// Height = fractal noise sampled through a low-frequency domain warp, which
// bends the landforms into the meandering ridges and valleys of real terrain.
// Each layer drifts in its own direction (noise units per second); their
// relative motion is what makes the surface slowly morph instead of sliding.

const WARP_AMOUNT = 0.55;
const WARP_SCALE = 0.45;
const OCTAVES = [
  { scale: 1, weight: 1, dx: 0.011, dy: 0.005, ox: 0, oy: 0 },
  { scale: 2.07, weight: 0.42, dx: -0.013, dy: 0.008, ox: 5.2, oy: 1.3 },
  { scale: 4.13, weight: 0.14, dx: 0.017, dy: -0.012, ox: 9.1, oy: -3.7 },
] as const;

// --- Pointer deformation ---------------------------------------------------
// LENS gently magnifies the terrain under the cursor (contours spread apart
// and bend around it); LIFT raises the ground a little, so lines bulge as if
// the surface were pressed from below. Both fade with a smooth, bell-shaped
// kernel (1 - d²/reach²)³ that reaches exactly zero, so there is no seam and
// no work at all outside the reach.

const LENS = 0.3;
const LIFT = 1.1; // in contour intervals
const REACH = 2; // in influence radii

/**
 * Terrain is evaluated as keyframes this many seconds of animation apart and
 * blended in between. Motion is slow enough that the blend is visually exact,
 * and each keyframe is built a few rows per frame, so the expensive noise
 * sampling is spread thinly instead of repeated every frame.
 */
const KEYFRAME_INTERVAL = 0.25;

/**
 * Renders an animated topographic map onto a 2D canvas.
 *
 * Pipeline per frame: blend the two current terrain keyframes into a height
 * grid (cost scales with grid points, not pixels), deform it around the
 * pointer, extract iso-lines with marching squares and stroke them in two
 * batched passes.
 */
export class TopographyRenderer {
  private readonly noise: Noise2D;
  private width = 0;
  private height = 0;
  private cell = 10;
  private cols = 0;
  private rows = 0;
  private featureSize = 0;
  /** Height grid that gets contoured, in contour intervals. */
  private field = new Float32Array(0);

  /** Keyframes at `fromTime` / `toTime`, plus the one being built for the next interval. */
  private from = new Float32Array(0);
  private to = new Float32Array(0);
  private next = new Float32Array(0);
  private fromTime = 0;
  private toTime = 0;
  private nextRowsBuilt = 0;
  private keyframesReady = false;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly options: TopographyOptions,
    private readonly style: TopographyStyle,
  ) {
    this.noise = createNoise2D(options.seed);
  }

  /**
   * Resize the sampling grid. `width`/`height` are in CSS pixels; `featureScale`
   * enlarges the landforms (and so the contour spacing) on bigger surfaces.
   */
  resize(width: number, height: number, cellSize: number, featureScale = 1): void {
    this.width = width;
    this.height = height;
    this.cell = cellSize;
    this.featureSize = this.options.featureSize * featureScale;
    this.cols = Math.ceil(width / cellSize) + 1;
    this.rows = Math.ceil(height / cellSize) + 1;
    const size = this.cols * this.rows;
    this.field = new Float32Array(size);
    this.from = new Float32Array(size);
    this.to = new Float32Array(size);
    this.next = new Float32Array(size);
    this.keyframesReady = false;
  }

  render(time: number, influence: TerrainInfluence | null): void {
    if (this.cols < 2 || this.rows < 2) return;
    const active = influence && influence.strength > 0.001 ? influence : null;
    this.advanceKeyframes(time);
    this.composeField(time, active);
    const { minor, major } = this.traceContours();
    this.draw(minor, major, active);
  }

  /** Keep `time` inside [fromTime, toTime] and incrementally build the following keyframe. */
  private advanceKeyframes(time: number): void {
    const { rows } = this;

    if (!this.keyframesReady || time < this.fromTime || time >= this.toTime + KEYFRAME_INTERVAL) {
      this.fromTime = time;
      this.toTime = time + KEYFRAME_INTERVAL;
      this.sampleTerrain(this.from, this.fromTime, 0, rows);
      this.sampleTerrain(this.to, this.toTime, 0, rows);
      this.nextRowsBuilt = 0;
      this.keyframesReady = true;
    } else if (time >= this.toTime) {
      // Finish whatever is left of the upcoming keyframe, then rotate buffers.
      this.sampleTerrain(this.next, this.toTime + KEYFRAME_INTERVAL, this.nextRowsBuilt, rows);
      const recycled = this.from;
      this.from = this.to;
      this.to = this.next;
      this.next = recycled;
      this.fromTime = this.toTime;
      this.toTime += KEYFRAME_INTERVAL;
      this.nextRowsBuilt = 0;
    }

    // Spread the next keyframe over the interval, aiming to finish a little early.
    const progress = Math.min(1, ((time - this.fromTime) / KEYFRAME_INTERVAL) * 1.2);
    const targetRows = Math.ceil(rows * progress);
    if (targetRows > this.nextRowsBuilt) {
      this.sampleTerrain(this.next, this.toTime + KEYFRAME_INTERVAL, this.nextRowsBuilt, targetRows);
      this.nextRowsBuilt = targetRows;
    }
  }

  /** Evaluate undeformed terrain height for grid rows [rowStart, rowEnd) at `time`. */
  private sampleTerrain(target: Float32Array, time: number, rowStart: number, rowEnd: number): void {
    const { noise, cols, cell } = this;
    const freq = 1 / this.featureSize;
    const toLevels = 1 / this.options.contourInterval;

    const [o1, o2, o3] = OCTAVES;
    const o1x = o1.ox + time * o1.dx, o1y = o1.oy + time * o1.dy;
    const o2x = o2.ox + time * o2.dx, o2y = o2.oy + time * o2.dy;
    const o3x = o3.ox + time * o3.dx, o3y = o3.oy + time * o3.dy;
    const wax = 31.7 + time * 0.009, way = -12.3 - time * 0.004;
    const wbx = -47.1 - time * 0.006, wby = 8.9 + time * 0.01;

    for (let j = rowStart; j < rowEnd; j++) {
      const fy = j * cell * freq;
      let index = j * cols;
      for (let i = 0; i < cols; i++, index++) {
        const fx = i * cell * freq;
        const qx = fx + WARP_AMOUNT * noise(fx * WARP_SCALE + wax, fy * WARP_SCALE + way);
        const qy = fy + WARP_AMOUNT * noise(fx * WARP_SCALE + wbx, fy * WARP_SCALE + wby);
        const h =
          o1.weight * noise(qx * o1.scale + o1x, qy * o1.scale + o1y) +
          o2.weight * noise(qx * o2.scale + o2x, qy * o2.scale + o2y) +
          o3.weight * noise(qx * o3.scale + o3x, qy * o3.scale + o3y);
        target[index] = h * toLevels;
      }
    }
  }

  /** Blend keyframes into `field`, then deform the neighbourhood of the pointer. */
  private composeField(time: number, influence: TerrainInfluence | null): void {
    const { field, from, to, cols, rows, cell } = this;
    const t = Math.min(1, Math.max(0, (time - this.fromTime) / KEYFRAME_INTERVAL));
    for (let k = 0; k < field.length; k++) field[k] = from[k] + (to[k] - from[k]) * t;
    if (!influence) return;

    const { x: cx, y: cy } = influence;
    const reach = influence.radius * REACH;
    const invReach2 = 1 / (reach * reach);
    const lens = LENS * influence.strength;
    const lift = LIFT * influence.strength;

    const iMin = Math.max(0, Math.floor((cx - reach) / cell));
    const iMax = Math.min(cols - 1, Math.ceil((cx + reach) / cell));
    const jMin = Math.max(0, Math.floor((cy - reach) / cell));
    const jMax = Math.min(rows - 1, Math.ceil((cy + reach) / cell));

    for (let j = jMin; j <= jMax; j++) {
      const dy = j * cell - cy;
      for (let i = iMin; i <= iMax; i++) {
        const dx = i * cell - cx;
        const u = (dx * dx + dy * dy) * invReach2;
        if (u >= 1) continue;
        const falloff = (1 - u) * (1 - u) * (1 - u);
        // Read the terrain from a point pulled towards the cursor: a soft lens.
        const sx = cx + dx * (1 - lens * falloff);
        const sy = cy + dy * (1 - lens * falloff);
        field[j * cols + i] = this.sampleBlended(sx, sy, t) + lift * falloff;
      }
    }
  }

  /** Bilinear lookup of the blended (undeformed) terrain at an arbitrary point. */
  private sampleBlended(x: number, y: number, t: number): number {
    const { from, to, cols, rows, cell } = this;
    const gx = Math.min(cols - 1.0001, Math.max(0, x / cell));
    const gy = Math.min(rows - 1.0001, Math.max(0, y / cell));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const k00 = j * cols + i;
    const k10 = k00 + 1;
    const k01 = k00 + cols;
    const k11 = k01 + 1;
    const v00 = from[k00] + (to[k00] - from[k00]) * t;
    const v10 = from[k10] + (to[k10] - from[k10]) * t;
    const v01 = from[k01] + (to[k01] - from[k01]) * t;
    const v11 = from[k11] + (to[k11] - from[k11]) * t;
    const top = v00 + (v10 - v00) * fx;
    const bottom = v01 + (v11 - v01) * fx;
    return top + (bottom - top) * fy;
  }

  /**
   * Marching squares over every integer level crossing each cell. Only the
   * levels between a cell's min and max corner are visited, so the cost stays
   * close to O(cells) regardless of how many contour levels exist.
   *
   * Segments are emitted left-edge-first and right-edge-last, so a contour
   * running across a row continues from the previous cell without a new
   * `moveTo` (see `SegmentBatch`).
   */
  private traceContours(): { minor: Path2D; major: Path2D } {
    const { cols, rows, cell, field } = this;
    const majorEvery = this.options.majorEvery;
    const minor = new SegmentBatch();
    const major = new SegmentBatch();

    for (let j = 0; j < rows - 1; j++) {
      const y0 = j * cell;
      const y1 = y0 + cell;
      const top = j * cols;
      const bottom = top + cols;

      for (let i = 0; i < cols - 1; i++) {
        const tl = field[top + i];
        const tr = field[top + i + 1];
        const br = field[bottom + i + 1];
        const bl = field[bottom + i];

        const lo = Math.min(tl, tr, br, bl);
        const hi = Math.max(tl, tr, br, bl);
        const kMin = Math.ceil(lo);
        const kMax = Math.ceil(hi) - 1;
        if (kMin > kMax) continue;

        const x0 = i * cell;
        const x1 = x0 + cell;

        for (let k = kMin; k <= kMax; k++) {
          const batch = k % majorEvery === 0 ? major : minor;
          const code = (tl > k ? 8 : 0) | (tr > k ? 4 : 0) | (br > k ? 2 : 0) | (bl > k ? 1 : 0);

          switch (code) {
            case 1:
            case 14: // left → bottom
              batch.segment(x0, y0 + cell * crossing(tl, bl, k), x0 + cell * crossing(bl, br, k), y1);
              break;
            case 2:
            case 13: // bottom → right
              batch.segment(x0 + cell * crossing(bl, br, k), y1, x1, y0 + cell * crossing(tr, br, k));
              break;
            case 3:
            case 12: // left → right
              batch.segment(x0, y0 + cell * crossing(tl, bl, k), x1, y0 + cell * crossing(tr, br, k));
              break;
            case 4:
            case 11: // top → right
              batch.segment(x0 + cell * crossing(tl, tr, k), y0, x1, y0 + cell * crossing(tr, br, k));
              break;
            case 6:
            case 9: // top → bottom
              batch.segment(x0 + cell * crossing(tl, tr, k), y0, x0 + cell * crossing(bl, br, k), y1);
              break;
            case 7:
            case 8: // left → top
              batch.segment(x0, y0 + cell * crossing(tl, bl, k), x0 + cell * crossing(tl, tr, k), y0);
              break;
            case 5:
            case 10: {
              // Saddle: the cell centre decides which diagonal is connected.
              const centreAbove = (tl + tr + br + bl) * 0.25 > k;
              const topX = x0 + cell * crossing(tl, tr, k);
              const rightY = y0 + cell * crossing(tr, br, k);
              const bottomX = x0 + cell * crossing(bl, br, k);
              const leftY = y0 + cell * crossing(tl, bl, k);
              if ((code === 5) === centreAbove) {
                batch.segment(x0, leftY, topX, y0);
                batch.segment(bottomX, y1, x1, rightY);
              } else {
                batch.segment(x0, leftY, bottomX, y1);
                batch.segment(topX, y0, x1, rightY);
              }
              break;
            }
          }
        }
      }
    }

    return { minor: minor.path, major: major.path };
  }

  private draw(minor: Path2D, major: Path2D, influence: TerrainInfluence | null): void {
    const { ctx, style } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.lineWidth = style.minorWidth;
    ctx.strokeStyle = this.strokeFor(style.minorAlpha, influence);
    ctx.stroke(minor);

    ctx.lineWidth = style.majorWidth;
    ctx.strokeStyle = this.strokeFor(style.majorAlpha, influence);
    ctx.stroke(major);
  }

  /** Flat colour, or a soft radial "glow" around the pointer when it is active. */
  private strokeFor(alpha: number, influence: TerrainInfluence | null): string | CanvasGradient {
    const { rgb, highlightAlpha } = this.style;
    if (!influence) return `rgba(${rgb}, ${alpha})`;

    const boost = highlightAlpha * influence.strength;
    const gradient = this.ctx.createRadialGradient(
      influence.x,
      influence.y,
      0,
      influence.x,
      influence.y,
      influence.radius * 1.8,
    );
    gradient.addColorStop(0, `rgba(${rgb}, ${alpha + boost})`);
    gradient.addColorStop(0.45, `rgba(${rgb}, ${alpha + boost * 0.35})`);
    gradient.addColorStop(1, `rgba(${rgb}, ${alpha})`);
    return gradient;
  }
}

/** Where, between corner values `a` and `b`, the level `k` is crossed (0..1). */
function crossing(a: number, b: number, k: number): number {
  return (k - a) / (b - a);
}

/**
 * Collects line segments into one `Path2D`, skipping the `moveTo` whenever a
 * segment starts where the previous one ended. Path calls cross into native
 * code, so halving them is the cheapest win in the render loop.
 */
class SegmentBatch {
  readonly path = new Path2D();
  private penX = NaN;
  private penY = NaN;

  segment(ax: number, ay: number, bx: number, by: number): void {
    if (Math.abs(ax - this.penX) > 0.01 || Math.abs(ay - this.penY) > 0.01) {
      this.path.moveTo(ax, ay);
    }
    this.path.lineTo(bx, by);
    this.penX = bx;
    this.penY = by;
  }
}
