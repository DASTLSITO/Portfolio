/**
 * Turns raw pointer positions into a smooth, physically-feeling influence:
 * the influence point trails the cursor, fades in/out when the cursor enters
 * or leaves, and swells slightly with pointer speed before settling again.
 *
 * Framework-agnostic and side-effect free: feed it positions with `track()` /
 * `release()` and advance it once per frame with `update(dt)`.
 */
export class PointerInfluence {
  /** Smoothed influence position, in canvas CSS pixels. */
  x = 0;
  y = 0;
  /** Overall deformation strength, 0..1. */
  strength = 0;
  /** Movement energy, 0..1. Rises with pointer speed and decays when idle. */
  energy = 0;

  private targetX = 0;
  private targetY = 0;
  private active = false;
  private presence = 0;
  private travelled = 0;

  /** Report the pointer at a position inside the surface. */
  track(x: number, y: number): void {
    if (!this.active && this.presence < 0.02) {
      // Entering from "nothing": appear under the cursor instead of sweeping in.
      this.x = this.targetX = x;
      this.y = this.targetY = y;
    } else {
      this.travelled += Math.hypot(x - this.targetX, y - this.targetY);
      this.targetX = x;
      this.targetY = y;
    }
    this.active = true;
  }

  /** The pointer left the surface (or interaction is disabled). */
  release(): void {
    this.active = false;
  }

  /** Advance the smoothing by `dt` seconds. */
  update(dt: number): void {
    const speed = dt > 0 ? this.travelled / dt : 0;
    this.travelled = 0;

    // Position follows the cursor with ~125ms of easing — fluid, never jittery.
    const follow = 1 - Math.exp(-dt * 8);
    this.x += (this.targetX - this.x) * follow;
    this.y += (this.targetY - this.y) * follow;

    // Fade in a little faster than out so the surface relaxes gently.
    const presenceRate = this.active ? 4 : 1.6;
    this.presence += ((this.active ? 1 : 0) - this.presence) * (1 - Math.exp(-dt * presenceRate));
    if (!this.active && this.presence < 0.003) this.presence = 0;

    // Speed injects energy quickly; it bleeds off over roughly a second.
    const energyTarget = Math.min(1, speed / 1600);
    const energyRate = energyTarget > this.energy ? 6 : 1.4;
    this.energy += (energyTarget - this.energy) * (1 - Math.exp(-dt * energyRate));

    this.strength = this.presence * (0.6 + 0.4 * this.energy);
  }

  /**
   * True when nothing is in motion: the influence has caught up with the
   * cursor, has no leftover energy and is not fading. The host can then drop
   * to a lower frame rate.
   */
  get settled(): boolean {
    const fading = this.presence > 0.003 && this.presence < 0.997;
    const trailing =
      Math.abs(this.targetX - this.x) > 0.25 || Math.abs(this.targetY - this.y) > 0.25;
    return !fading && !trailing && this.energy < 0.01;
  }
}
