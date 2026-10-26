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
 *
 * # Touch contacts
 *
 * - Beyond the single-pointer view, adapters feed individual touch contacts
 *   through `handleTouchStart`/`handleTouchMove`/`handleTouchEnd`/
 *   `handleTouchCancel` keyed by the contact's stable id (the DOM
 *   `pointerId` for pointer-event adapters). Multiple simultaneous contacts
 *   are supported.
 * - Touch edges (`wasTouchStarted`/`wasTouchEnded`/`wasTouchCancelled`)
 *   follow the same per-frame semantics as keys and buttons: set by events,
 *   reset together at `endFrame()`.
 * - Focus loss cancels every active contact with a cancelled edge; adapter
 *   disposal and `pointercancel` reach the same policy through
 *   `handleTouchCancel`.
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

  readonly #touches = new Map<number, { x: number; y: number }>();
  readonly #touchesStarted = new Set<number>();
  readonly #touchesEnded = new Set<number>();
  readonly #touchesCancelled = new Set<number>();

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
    // Every touch contact dies with the page's focus; the positions go
    // with them (there is no meaningful place to keep pointing at).
    for (const id of this.#touches.keys()) {
      this.#touchesCancelled.add(id);
    }
    this.#touches.clear();
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

  /**
   * Record the start of a touch contact. `id` is the adapter's stable
   * contact identifier (the DOM `pointerId` for pointer-event adapters);
   * coordinates use the same canvas-relative space as the pointer.
   * Non-finite coordinates are ignored, so a broken event payload cannot
   * poison positions. Starting an already-active contact updates its
   * position and does not create a second start edge.
   */
  handleTouchStart(id: number, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    if (!this.#touches.has(id)) {
      this.#touchesStarted.add(id);
      this.#touchesEnded.delete(id);
      this.#touchesCancelled.delete(id);
    }
    this.#touches.set(id, { x, y });
  }

  /** Record movement of an active touch contact. Unknown ids are ignored. */
  handleTouchMove(id: number, x: number, y: number): void {
    const touch = this.#touches.get(id);
    if (touch === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    touch.x = x;
    touch.y = y;
  }

  /** Record the end of a touch contact. Unknown ids are ignored. */
  handleTouchEnd(id: number): void {
    if (this.#touches.delete(id)) {
      this.#touchesEnded.add(id);
      this.#touchesStarted.delete(id);
      this.#touchesCancelled.delete(id);
    }
  }

  /**
   * Record the cancellation of a touch contact (e.g. the browser claims
   * the gesture for page scrolling). Unknown ids are ignored. Cancellation
   * has its own edge so game code can distinguish an intentional lift from
   * a system take-over.
   */
  handleTouchCancel(id: number): void {
    if (this.#touches.delete(id)) {
      this.#touchesCancelled.add(id);
      this.#touchesStarted.delete(id);
      this.#touchesEnded.delete(id);
    }
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

  /** Number of currently active touch contacts. */
  get touchCount(): number {
    return this.#touches.size;
  }

  /** Ids of every active touch contact, sorted ascending. */
  activeTouchIds(): number[] {
    return [...this.#touches.keys()].sort((a, b) => a - b);
  }

  /** Whether a touch contact is currently active. */
  isTouchActive(id: number): boolean {
    return this.#touches.has(id);
  }

  /** Position of an active touch contact, or `undefined` when absent. */
  getTouchPosition(id: number): { x: number; y: number } | undefined {
    const touch = this.#touches.get(id);
    return touch === undefined ? undefined : { x: touch.x, y: touch.y };
  }

  /** Whether the contact started since the last `endFrame()`. */
  wasTouchStarted(id: number): boolean {
    return this.#touchesStarted.has(id);
  }

  /** Whether the contact ended since the last `endFrame()`. */
  wasTouchEnded(id: number): boolean {
    return this.#touchesEnded.has(id);
  }

  /** Whether the contact was cancelled since the last `endFrame()`. */
  wasTouchCancelled(id: number): boolean {
    return this.#touchesCancelled.has(id);
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
    this.#touchesStarted.clear();
    this.#touchesEnded.clear();
    this.#touchesCancelled.clear();
  }
}
