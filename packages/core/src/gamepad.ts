/**
 * Renderer-agnostic, DOM-free gamepad state.
 *
 * `GamepadState` is a plain state machine, mirroring {@link InputState}'s
 * design: a browser adapter (such as `@g2w/input-gamepad`) samples real
 * hardware and feeds it through the `handle*` methods, and game code reads
 * the state through the query methods. It references no browser Gamepad
 * types — samples are plain numbers and booleans — so core stays free of
 * browser APIs.
 *
 * # Frame semantics
 *
 * - Button held state is continuous: `isButtonDown` reports whether the
 *   button was held at the most recent sample for that controller.
 * - `pressed`/`released` are per-frame edge states. Edges are computed
 *   **per game frame, not per sample**: an adapter may sample many times
 *   between two `endFrame()` calls, and a button that went down and up
 *   within one frame reports both `wasButtonPressed` and
 *   `wasButtonReleased` that frame. All edges reset at `endFrame()`, at
 *   one explicit boundary, exactly like `InputState`.
 * - Axes hold the latest sampled values across frames; they have no edges.
 *
 * # Connection policy
 *
 * - `handleConnected(index)` marks the controller at `index` as connected.
 *   Sampling a controller that was never connected implies connection —
 *   a snapshot's arrival is itself evidence the controller exists.
 * - `handleDisconnected(index)` clears the controller's held buttons and
 *   axes, emits released edges for every held button, and marks it
 *   disconnected. The cleared state is never retained, so a controller
 *   that reconnects (possibly at a different index) starts from a clean
 *   slate instead of resurrecting stale input.
 * - Hardware indices are not stable across reconnects on real browsers;
 *   a reconnected controller may occupy a vacant index. Callers that need
 *   a stable identity should treat `index` as "the controller currently
 *   at this slot", which is what every query here reports.
 */
export interface GamepadSnapshot {
  /** Pressed state per button, indexed by standard button index. */
  readonly pressed: readonly boolean[];
  /** Analog axis values, indexed by standard axis index. Unnormalized. */
  readonly axes: readonly number[];
}

export class GamepadState {
  readonly #connected = new Set<number>();
  readonly #buttonsDown = new Map<number, Set<number>>();
  readonly #buttonsPressed = new Map<number, Set<number>>();
  readonly #buttonsReleased = new Map<number, Set<number>>();
  readonly #axes = new Map<number, number[]>();

  // --- Adapter-facing feed -------------------------------------------------

  /** Mark the controller at `index` as connected (idempotent). */
  handleConnected(index: number): void {
    this.#connected.add(index);
  }

  /**
   * Mark the controller at `index` as disconnected: release every held
   * button with released edges and drop its axes. Safe to call for an
   * already-absent index (a no-op).
   */
  handleDisconnected(index: number): void {
    if (!this.#connected.delete(index)) {
      return;
    }
    const down = this.#buttonsDown.get(index);
    if (down !== undefined) {
      const released = this.#edgesFor(this.#buttonsReleased, index);
      for (const button of down) {
        released.add(button);
      }
      down.clear();
    }
    this.#buttonsPressed.delete(index);
    this.#axes.delete(index);
  }

  /**
   * Feed one sample for the controller at `index`. The first sample for an
   * index implies connection. Rising button transitions add pressed edges,
   * falling transitions add released edges; axes are stored as-is.
   * Non-finite axis values in a sample are ignored (defensive: real
   * hardware does not produce them, injected fakes might).
   */
  handleSample(index: number, snapshot: GamepadSnapshot): void {
    this.#connected.add(index);

    const down = this.#edgesFor(this.#buttonsDown, index);
    const pressed = this.#edgesFor(this.#buttonsPressed, index);
    const released = this.#edgesFor(this.#buttonsReleased, index);
    for (let button = 0; button < snapshot.pressed.length; button++) {
      const isPressed = snapshot.pressed[button] === true;
      const wasDown = down.has(button);
      if (isPressed && !wasDown) {
        down.add(button);
        pressed.add(button);
      } else if (!isPressed && wasDown) {
        down.delete(button);
        released.add(button);
      }
    }
    // A sample defines the controller's full button state: buttons still
    // held beyond the sample's length were not reported this time and are
    // released (real hardware always reports every button; injected fakes
    // may shrink the array, and the state must not hold stale buttons).
    for (const button of [...down]) {
      if (button >= snapshot.pressed.length) {
        down.delete(button);
        released.add(button);
      }
    }

    if (snapshot.axes.length > 0) {
      const axes: number[] = [];
      for (const value of snapshot.axes) {
        axes.push(Number.isFinite(value) ? value : 0);
      }
      this.#axes.set(index, axes);
    } else {
      this.#axes.delete(index);
    }
  }

  // --- Game-facing queries -------------------------------------------------

  /** Whether a controller is currently connected at `index`. */
  isConnected(index: number): boolean {
    return this.#connected.has(index);
  }

  /** Indices of every connected controller, sorted ascending. */
  connectedIndices(): number[] {
    return [...this.#connected].sort((a, b) => a - b);
  }

  /** Whether the button is currently held on the controller at `index`. */
  isButtonDown(index: number, button: number): boolean {
    return this.#buttonsDown.get(index)?.has(button) === true;
  }

  /** Whether the button was pressed since the last `endFrame()`. */
  wasButtonPressed(index: number, button: number): boolean {
    return this.#buttonsPressed.get(index)?.has(button) === true;
  }

  /** Whether the button was released since the last `endFrame()`. */
  wasButtonReleased(index: number, button: number): boolean {
    return this.#buttonsReleased.get(index)?.has(button) === true;
  }

  /**
   * Latest sampled value of the axis at `axisIndex` on the controller at
   * `index`: `0` when the controller is absent or the axis was never
   * sampled (a neutral reading, not an error). Values are raw — no dead
   * zone is imposed; game code applies its own thresholds.
   */
  getAxis(index: number, axisIndex: number): number {
    return this.#axes.get(index)?.[axisIndex] ?? 0;
  }

  /** Copy of the latest sampled axes for the controller at `index`. */
  getAxes(index: number): number[] {
    return [...(this.#axes.get(index) ?? [])];
  }

  /**
   * Reset every per-frame edge state (pressed and released, all
   * controllers). Call exactly once per game frame after all consumers
   * read the state; held state, axes, and connectivity are never affected.
   */
  endFrame(): void {
    this.#buttonsPressed.clear();
    this.#buttonsReleased.clear();
  }

  #edgesFor(map: Map<number, Set<number>>, index: number): Set<number> {
    let edges = map.get(index);
    if (edges === undefined) {
      edges = new Set();
      map.set(index, edges);
    }
    return edges;
  }
}
