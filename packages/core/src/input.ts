/**
 * Renderer-agnostic, DOM-free input state for keyboard and pointer.
 *
 * `InputState` is a plain state machine: browser adapters (such as
 * `@g2w/input-dom`) feed it normalized events through the `handle*` methods,
 * and game or scene code reads it through the query methods. It holds no
 * references to `window`, `document`, DOM events, or any renderer.
 *
 * # Frame semantics
 *
 * - `down` (held) state is continuous: `isKeyDown`/`isButtonDown` report
 *   whether the key or button is currently held.
 * - `pressed`/`released` are per-frame edge states. They are set by input
 *   events and stay observable until the next {@link InputState.endFrame}
 *   call, where they reset — all of them, at once, at one explicit boundary.
 * - A quick press-and-release between two `endFrame` calls is not lost: the
 *   key reports `wasKeyPressed` **and** `wasKeyReleased` in the same frame
 *   while `isKeyDown` is already `false` again.
 * - Repeated `keydown` events (OS key repeat) while a key is already held do
 *   not create additional press transitions; the key stays held with a single
 *   press edge.
 * - Call `endFrame()` exactly once per game frame, after every consumer has
 *   read the state (e.g. after scene updates inside `Game.onUpdate`). Events
 *   that arrive later accumulate into the next frame's edges.
 *
 * # Focus and pointer-leave policy
 *
 * - Focus loss (`handleFocusLoss`) releases every held key and button and
 *   generates the corresponding released edges, so game logic observes the
 *   same release it would have seen from real keyup/pointerup events. The
 *   pointer position is kept.
 * - Pointer leaving the canvas (`handlePointerLeave`) releases held pointer
 *   buttons with their edges (the matching `pointerup` may happen off-canvas)
 *   and keeps the last pointer position.
 */
export class InputState {
  readonly #keysDown = new Set<string>();
  readonly #keysPressed = new Set<string>();
  readonly #keysReleased = new Set<string>();

  readonly #buttonsDown = new Set<number>();
  readonly #buttonsPressed = new Set<number>();
  readonly #buttonsReleased = new Set<number>();

  #pointerX = 0;
  #pointerY = 0;
  #hasPointerPosition = false;

  // --- Adapter-facing feed -------------------------------------------------

  /** Record a key press. OS key repeat while the key is held is ignored. */
  handleKeyDown(code: string): void {
    if (!this.#keysDown.has(code)) {
      this.#keysDown.add(code);
      this.#keysPressed.add(code);
    }
  }

  /** Record a key release. A release for a key that is not held is ignored. */
  handleKeyUp(code: string): void {
    if (this.#keysDown.delete(code)) {
      this.#keysReleased.add(code);
    }
  }

  /**
   * Record the pointer position in canvas-relative coordinates (the same
   * units the game uses for layout, typically canvas pixels).
   */
  handlePointerMove(x: number, y: number): void {
    this.#pointerX = x;
    this.#pointerY = y;
    this.#hasPointerPosition = true;
  }

  /** Record a pointer button press. */
  handleButtonDown(button: number): void {
    if (!this.#buttonsDown.has(button)) {
      this.#buttonsDown.add(button);
      this.#buttonsPressed.add(button);
    }
  }

  /** Record a pointer button release. A release for an unheld button is ignored. */
  handleButtonUp(button: number): void {
    if (this.#buttonsDown.delete(button)) {
      this.#buttonsReleased.add(button);
    }
  }

  /**
   * Release every held key and button with released edges (focus-loss policy;
   * see the class documentation).
   */
  handleFocusLoss(): void {
    for (const code of this.#keysDown) {
      this.#keysReleased.add(code);
    }
    this.#keysDown.clear();
    for (const button of this.#buttonsDown) {
      this.#buttonsReleased.add(button);
    }
    this.#buttonsDown.clear();
  }

  /**
   * Release held pointer buttons with released edges and keep the last
   * pointer position (pointer-leave policy; see the class documentation).
   */
  handlePointerLeave(): void {
    for (const button of this.#buttonsDown) {
      this.#buttonsReleased.add(button);
    }
    this.#buttonsDown.clear();
  }

  // --- Game-facing queries -------------------------------------------------

  /** Whether the key with the given identifier is currently held. */
  isKeyDown(code: string): boolean {
    return this.#keysDown.has(code);
  }

  /** Whether the key was pressed since the last `endFrame()`. */
  wasKeyPressed(code: string): boolean {
    return this.#keysPressed.has(code);
  }

  /** Whether the key was released since the last `endFrame()`. */
  wasKeyReleased(code: string): boolean {
    return this.#keysReleased.has(code);
  }

  /** Whether the pointer button (0 = primary) is currently held. */
  isButtonDown(button: number): boolean {
    return this.#buttonsDown.has(button);
  }

  /** Whether the pointer button was pressed since the last `endFrame()`. */
  wasButtonPressed(button: number): boolean {
    return this.#buttonsPressed.has(button);
  }

  /** Whether the pointer button was released since the last `endFrame()`. */
  wasButtonReleased(button: number): boolean {
    return this.#buttonsReleased.has(button);
  }

  /** Last recorded pointer X in canvas-relative coordinates. */
  get pointerX(): number {
    return this.#pointerX;
  }

  /** Last recorded pointer Y in canvas-relative coordinates. */
  get pointerY(): number {
    return this.#pointerY;
  }

  /** Whether any pointer position has been recorded yet. */
  get hasPointerPosition(): boolean {
    return this.#hasPointerPosition;
  }

  /**
   * Reset every per-frame edge state (pressed and released, keys and
   * buttons). Call exactly once per game frame after all consumers read the
   * state; held (`down`) state is never affected.
   */
  endFrame(): void {
    this.#keysPressed.clear();
    this.#keysReleased.clear();
    this.#buttonsPressed.clear();
    this.#buttonsReleased.clear();
  }
}
