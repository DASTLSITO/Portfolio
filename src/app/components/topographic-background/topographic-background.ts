import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  NgZone,
  viewChild,
} from '@angular/core';
import { PointerInfluence } from './pointer-influence';
import { TerrainInfluence, TopographyRenderer, TopographyStyle } from './topography-renderer';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/** Device-pixel-ratio cap: sharper than 2x costs fill-rate for no visible gain on thin lines. */
const MAX_DPR = 2;
/** Upper bound on sampled grid points; very large screens get a coarser grid instead. */
const MAX_GRID_POINTS = 20_000;
const TABLET_MIN_WIDTH = 768;
/** Viewport area at which terrain is drawn at its nominal scale. */
const REFERENCE_AREA = 1440 * 900;

/** Full frame rate while the surface reacts to the pointer, half when only drifting. */
const ACTIVE_FRAME_MS = 1000 / 60 - 1;
const AMBIENT_FRAME_MS = 1000 / 30 - 1;

const LINE_STYLE: Omit<TopographyStyle, 'rgb'> = {
  minorAlpha: 0.075,
  majorAlpha: 0.16,
  highlightAlpha: 0.11,
  minorWidth: 1,
  majorWidth: 1.25,
};

/**
 * Living topographic-map background: contour lines that slowly evolve and
 * bend around the mouse like a flexible terrain surface.
 *
 * Fills its nearest positioned ancestor and never intercepts input. Line
 * colour follows `--topo-line-color` (falls back to `--text-main`).
 */
@Component({
  selector: 'app-topographic-background',
  templateUrl: './topographic-background.html',
  styleUrl: './topographic-background.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class TopographicBackground {
  /** Enable mouse-driven deformation (only applies to devices with a fine pointer). */
  readonly interactive = input(true);
  /** Terrain seed; change it for a different landscape. Read once on init. */
  readonly seed = input(7);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);

  private readonly pointer = new PointerInfluence();
  private readonly listeners = new AbortController();
  private observers: Array<ResizeObserver | IntersectionObserver> = [];

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private renderer?: TopographyRenderer;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private frameId = 0;
  private lastFrame = 0;
  /** Seconds of ambient animation; only advances while animating. */
  private time = 0;

  private inView = true;
  private reducedMotion = false;
  private finePointer = false;
  private pointerInWindow = false;
  private clientX = 0;
  private clientY = 0;

  constructor() {
    afterNextRender(() => this.zone.runOutsideAngular(() => this.setup()));
    inject(DestroyRef).onDestroy(() => this.teardown());
  }

  private setup(): void {
    const canvas = this.canvasRef().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ResizeObserver === 'undefined' || typeof matchMedia !== 'function') return;

    this.canvas = canvas;
    this.ctx = ctx;
    this.renderer = new TopographyRenderer(
      ctx,
      { seed: this.seed(), featureSize: 560, contourInterval: 0.15, majorEvery: 5 },
      { ...LINE_STYLE, rgb: this.readLineColor() },
    );

    const signal = this.listeners.signal;
    const reducedMotion = matchMedia(REDUCED_MOTION_QUERY);
    const finePointer = matchMedia(FINE_POINTER_QUERY);
    this.reducedMotion = reducedMotion.matches;
    this.finePointer = finePointer.matches;

    reducedMotion.addEventListener(
      'change',
      (event) => {
        this.reducedMotion = event.matches;
        this.updateLoop();
      },
      { signal },
    );
    finePointer.addEventListener(
      'change',
      (event) => {
        this.finePointer = event.matches;
        this.resize(true);
      },
      { signal },
    );

    // Pointer is read from the window: the canvas itself ignores all input.
    window.addEventListener('pointermove', this.onPointerMove, { passive: true, signal });
    document.addEventListener(
      'pointerout',
      (event) => {
        if (!event.relatedTarget) this.pointerInWindow = false;
      },
      { passive: true, signal },
    );
    window.addEventListener('blur', () => (this.pointerInWindow = false), { signal });
    document.addEventListener('visibilitychange', () => this.updateLoop(), { signal });

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(this.host);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      this.inView = entry.isIntersecting;
      this.updateLoop();
    });
    intersectionObserver.observe(this.host);
    this.observers = [resizeObserver, intersectionObserver];

    this.resize();
    this.updateLoop();
  }

  private teardown(): void {
    this.stop();
    this.listeners.abort();
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.clientX = event.clientX;
    this.clientY = event.clientY;
    this.pointerInWindow = true;
  };

  /** Start or stop the loop depending on visibility and motion preferences. */
  private updateLoop(): void {
    const animate = !this.reducedMotion && this.inView && document.visibilityState === 'visible';
    if (animate) {
      this.start();
      return;
    }
    this.stop();
    if (this.reducedMotion) {
      // A still, undeformed map: same look, no motion.
      this.pointer.release();
      this.renderer?.render(this.time, null);
    }
  }

  private start(): void {
    if (this.frameId) return;
    this.lastFrame = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private readonly tick = (now: number): void => {
    this.frameId = requestAnimationFrame(this.tick);

    const interactive = this.isInteractive();
    const minInterval = interactive && !this.pointer.settled ? ACTIVE_FRAME_MS : AMBIENT_FRAME_MS;
    const elapsed = now - this.lastFrame;
    if (elapsed < minInterval) return;
    this.lastFrame = now;

    if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== this.dpr) this.resize();

    const dt = Math.min(elapsed, 100) / 1000;
    this.time += dt;
    if (interactive) this.trackPointer();
    else this.pointer.release();
    this.pointer.update(dt);

    this.renderer?.render(this.time, this.influence());
  };

  private isInteractive(): boolean {
    return this.interactive() && this.finePointer && !this.reducedMotion;
  }

  /** Map the last known client position into canvas space (handles scrolling too). */
  private trackPointer(): void {
    if (!this.canvas || !this.pointerInWindow) {
      this.pointer.release();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = this.clientX - rect.left;
    const y = this.clientY - rect.top;
    if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) this.pointer.track(x, y);
    else this.pointer.release();
  }

  private influence(): TerrainInfluence | null {
    if (this.pointer.strength <= 0) return null;
    const baseRadius = Math.min(260, Math.max(150, Math.min(this.width, this.height) * 0.24));
    return {
      x: this.pointer.x,
      y: this.pointer.y,
      strength: this.pointer.strength,
      radius: baseRadius * (1 + 0.3 * this.pointer.energy),
    };
  }

  private resize(force = false): void {
    const { canvas, ctx, renderer } = this;
    if (!canvas || !ctx || !renderer) return;

    const width = Math.max(1, Math.round(this.host.clientWidth));
    const height = Math.max(1, Math.round(this.host.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (!force && width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.resize(width, height, this.cellSizeFor(width, height), this.featureScaleFor(width, height));

    // Resizing clears the bitmap; repaint now so there is never a blank frame.
    renderer.render(this.time, this.reducedMotion ? null : this.influence());
  }

  /**
   * Grid resolution in CSS px. Small (usually high-DPR) screens are cheap to
   * sample, so they get the finest grid; large screens are capped by point count.
   */
  private cellSizeFor(width: number, height: number): number {
    const base = this.finePointer && width >= TABLET_MIN_WIDTH ? 9 : 8;
    return Math.max(base, Math.sqrt((width * height) / MAX_GRID_POINTS));
  }

  /**
   * Landforms grow gently with the surface so big monitors get the same calm
   * composition rather than a denser mesh of lines (which would also cost more).
   */
  private featureScaleFor(width: number, height: number): number {
    return Math.min(1.5, Math.max(0.85, Math.sqrt((width * height) / REFERENCE_AREA)));
  }

  /** Resolve the themed line colour (CSS `color` on the host) to an `r, g, b` triplet. */
  private readLineColor(): string {
    const channels = getComputedStyle(this.host).color.match(/[\d.]+/g);
    return channels && channels.length >= 3 ? channels.slice(0, 3).join(', ') : '240, 240, 240';
  }
}
