import type { InputState } from "@g2w/core";

/** Error thrown for invalid `DomInput` lifecycle usage. */
export class DomInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomInputError";
  }
}

/** Options for constructing a {@link DomInput}. */
export interface DomInputOptions {
  /**
   * The canvas whose bounding box defines the pointer coordinate space and
   * which receives `pointermove`, `pointerdown`, and `pointerleave` events.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * Target for keyboard events. Defaults to `window`; a canvas only receives
   * key events while it has focus, so the default listens on the window.
   */
  readonly keyTarget?: EventTarget;
  /** Target for focus-loss events. Defaults to `window`. */
  readonly blurTarget?: EventTarget;
  /** Target for `pointerup` events. Defaults to `window`, so a release that
   * happens off-canvas is still observed. */
  readonly pointerUpTarget?: EventTarget;
  /**
   * The game's logical coordinate space. When provided, pointer coordinates
   * are mapped into this space (the renderer's logical resolution), so game
   * code reads positions in stage coordinates regardless of the canvas's
   * backing resolution or CSS display scaling. When omitted, coordinates are
   * mapped into the canvas's backing pixels (`canvas.width`/`canvas.height`),
   * the behavior before logical sizing existed.
   */
  readonly logicalSize?: { readonly width: number; readonly height: number };
}

interface ListenerRegistration {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListener;
}

/**
 * Browser input adapter: subscribes to DOM keyboard and pointer events and
 * feeds them into a core {@link InputState}. It performs no input logic of
 * its own beyond normalization — coordinates are converted to canvas-relative
 * pixels and event payloads are mapped to `InputState`'s feed methods.
 *
 * Touch policy: touch contact events arrive through the same Pointer Events
 * stream and are additionally fed into `InputState`'s multi-touch contract
 * keyed by `pointerId` (`pointerType === "touch"` only), so game code can
 * track several simultaneous contacts while the single-pointer view keeps
 * working unchanged for mouse and keyboard users. `pointercancel` releases
 * the cancelled contact (and button state for non-touch pointers) — a
 * cancelled pointer never leaves state stuck as held.
 *
 * Listener policy:
 * - `attach()` is idempotent; repeated calls never duplicate listeners.
 * - `dispose()` removes every listener this adapter registered and is
 *   idempotent. A disposed adapter cannot be attached again.
 * - The adapter never calls `preventDefault()`; page scrolling and other
 *   default behavior stay under the application's control.
 *
 * Coordinate policy: pointer coordinates are canvas-relative pixels scaled
 * into the configured target space — the `logicalSize` game space when
 * provided, otherwise the canvas's backing resolution (`canvas.width`/
 * `canvas.height`) — so values match the space game code uses even when CSS
 * scales or letterboxes the canvas.
 *
 * Ownership: the caller owns the `InputState`, this adapter, and any `Game`
 * and `SceneManager`; each must be disposed separately. A typical teardown
 * order is adapter first (so no further events reach the state), then scenes,
 * then the game.
 */
export class DomInput {
  readonly #state: InputState;
  readonly #options: DomInputOptions;
  readonly #registrations: ListenerRegistration[] = [];

  #attached = false;
  #disposed = false;

  constructor(state: InputState, options: DomInputOptions) {
    this.#state = state;
    this.#options = options;
  }

  /**
   * Subscribe to all DOM events this adapter handles. Idempotent: calling it
   * again while attached is a no-op. Throws {@link DomInputError} after
   * disposal.
   */
  attach(): void {
    if (this.#disposed) {
      throw new DomInputError("Cannot attach a disposed DomInput.");
    }
    if (this.#attached) {
      return;
    }
    this.#attached = true;

    const canvas = this.#options.canvas;
    const keyTarget = this.#options.keyTarget ?? window;
    const blurTarget = this.#options.blurTarget ?? window;
    const pointerUpTarget = this.#options.pointerUpTarget ?? window;

    this.#register(keyTarget, "keydown", (event) => {
      this.#state.handleKeyDown((event as KeyboardEvent).code);
    });
    this.#register(keyTarget, "keyup", (event) => {
      this.#state.handleKeyUp((event as KeyboardEvent).code);
    });
    this.#register(blurTarget, "blur", () => {
      this.#state.handleFocusLoss();
    });
    this.#register(canvas, "pointermove", (event) => {
      const pointerEvent = event as PointerEvent;
      const [x, y] = this.#toCanvasCoordinates(pointerEvent.clientX, pointerEvent.clientY);
      this.#state.handlePointerMove(x, y);
      if (pointerEvent.pointerType === "touch") {
        this.#state.handleTouchMove(pointerEvent.pointerId, x, y);
      }
    });
    this.#register(canvas, "pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      const [x, y] = this.#toCanvasCoordinates(pointerEvent.clientX, pointerEvent.clientY);
      this.#state.handlePointerMove(x, y);
      this.#state.handleButtonDown(pointerEvent.button);
      if (pointerEvent.pointerType === "touch") {
        this.#state.handleTouchStart(pointerEvent.pointerId, x, y);
      }
    });
    this.#register(pointerUpTarget, "pointerup", (event) => {
      const pointerEvent = event as PointerEvent;
      this.#state.handleButtonUp(pointerEvent.button);
      if (pointerEvent.pointerType === "touch") {
        this.#state.handleTouchEnd(pointerEvent.pointerId);
      }
    });
    // A cancelled pointer (the browser claims the gesture for scrolling, an
    // incoming call, palm rejection, ...) never produces a matching `up`:
    // release the button state and cancel the touch contact so nothing
    // stays held. `preventDefault` stays untouched — scrolling behavior is
    // the page's choice, not this adapter's.
    this.#register(pointerUpTarget, "pointercancel", (event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.pointerType === "touch") {
        this.#state.handleTouchCancel(pointerEvent.pointerId);
      } else {
        this.#state.handlePointerLeave();
      }
    });
    this.#register(canvas, "pointerleave", () => {
      this.#state.handlePointerLeave();
    });
  }

  /**
   * Remove every listener this adapter registered. Idempotent and terminal:
   * later calls are no-ops and the adapter cannot be attached again.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#attached = false;
    for (const { target, type, listener } of this.#registrations) {
      target.removeEventListener(type, listener);
    }
    this.#registrations.length = 0;
  }

  /** Whether the adapter is currently attached to its event targets. */
  get attached(): boolean {
    return this.#attached;
  }

  #register(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const listener: EventListener = (event) => handler(event);
    this.#registrations.push({ target, type, listener });
    target.addEventListener(type, listener);
  }

  #toCanvasCoordinates(clientX: number, clientY: number): [x: number, y: number] {
    const rect = this.#options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // A zero-sized canvas has no meaningful mapping; report the raw
      // offset rather than dividing by zero. Values normalize on the next
      // move once the canvas has a size again.
      return [clientX - rect.left, clientY - rect.top];
    }
    // Map into the target space: logical when configured (CSS-relative
    // scaling to the game's stage space), backing pixels otherwise. The
    // bounding rectangle already accounts for CSS scaling and offsets, so
    // letterboxing or proportional display scaling are handled by the ratio.
    const target = this.#options.logicalSize;
    const scaleX = target ? target.width / rect.width : this.#options.canvas.width / rect.width;
    const scaleY = target ? target.height / rect.height : this.#options.canvas.height / rect.height;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return [x, y];
  }
}
