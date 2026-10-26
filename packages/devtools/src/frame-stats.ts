/**
 * Frame statistics for the DevTools performance panel, computed from the
 * overlay's own frame loop deltas — a fixed-size ring buffer of recent frame
 * times, so cost is constant regardless of session length.
 */
export class FrameStats {
  readonly #deltas: number[] = [];
  readonly #capacity: number;

  constructor(capacity = 120) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("FrameStats capacity must be a positive integer.");
    }
    this.#capacity = capacity;
  }

  /** How many frame samples are currently held. */
  get samples(): number {
    return this.#deltas.length;
  }

  /**
   * Records one frame delta in **seconds** (matching the g2w `deltaTime`
   * convention) and drops the oldest sample once the buffer is full.
   */
  push(deltaSeconds: number): void {
    if (this.#deltas.length >= this.#capacity) {
      this.#deltas.shift();
    }
    this.#deltas.push(deltaSeconds);
  }

  /**
   * Average frames per second over the buffered window, or `null` before the
   * first two samples (a one-sample window cannot distinguish a frame rate).
   */
  get fps(): number | null {
    if (this.#deltas.length < 2) {
      return null;
    }
    const total = this.#deltas.reduce((sum, delta) => sum + delta, 0);
    if (total <= 0) {
      return null;
    }
    return this.#deltas.length / total;
  }

  /** Average frame time in milliseconds over the buffered window, or `null` with no samples. */
  get frameMs(): number | null {
    if (this.#deltas.length === 0) {
      return null;
    }
    const total = this.#deltas.reduce((sum, delta) => sum + delta, 0);
    return (total / this.#deltas.length) * 1000;
  }

  /** Empties the buffer. */
  clear(): void {
    this.#deltas.length = 0;
  }
}
