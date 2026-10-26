import type { FrameRequestCallback, FrameScheduler } from "./frame-scheduler.js";
import { GameError } from "./game-error.js";
import { createRequestAnimationFrameScheduler } from "./raf-frame-scheduler.js";
import type { Renderer, RendererInitOptions } from "./renderer.js";

/**
 * Lifecycle states of a {@link Game}.
 *
 * Transitions:
 *
 * ```text
 * new ──init()──► initializing ──ok──► initialized ──start()──► running
 *                   │                                       ▲       │
 *                   │ init failure: rethrow,                │       │
 *                   ▼ returns to "new"                 start()   stop()
 *                  new                                       │       ▼
 *                                                            └─── stopped
 *
 * any state ──dispose()──► disposed (terminal, idempotent)
 * ```
 */
export type GameState = "new" | "initializing" | "initialized" | "running" | "stopped" | "disposed";

/** Options for constructing a {@link Game}. */
export interface GameOptions {
  /** The renderer the game owns for its lifetime. */
  readonly renderer: Renderer;
  /** The canvas passed to the renderer on initialization. */
  readonly canvas: HTMLCanvasElement;
  /** Optional background color passed through to the renderer. */
  readonly backgroundColor?: string;
  /** Optional resolution passed through to the renderer. */
  readonly resolution?: number;
  /**
   * Logical resolution width passed through to the renderer. Optional; see
   * `RendererInitOptions.width` for the semantics (both dimensions or
   * neither, finite and greater than zero).
   */
  readonly width?: number;
  /** Logical resolution height passed through to the renderer. Optional. */
  readonly height?: number;
  /**
   * Called once per frame with the elapsed time in seconds, after the game
   * enters the running state and before the renderer renders the frame.
   * An exception thrown here stops the frame loop (state returns to
   * `"stopped"`) and the error is rethrown to the scheduler.
   */
  readonly onUpdate?: (deltaTime: number) => void;
  /**
   * Upper bound for a single frame's delta in seconds. Protects the update
   * logic from a huge jump after a suspended tab or stalled scheduler.
   * Defaults to `0.25`; must be a finite number greater than zero.
   */
  readonly maxDeltaTime?: number;
  /**
   * Frame scheduler override. Defaults to a `requestAnimationFrame`-backed
   * scheduler. Intended for tests to drive frames deterministically.
   */
  readonly scheduler?: FrameScheduler;
}

/**
 * Owns the lifecycle of a renderer and a frame loop.
 *
 * State-transition policy (all of it is tested):
 * - `init()` is only valid from `"new"`; concurrent calls share the same
 *   in-flight promise, so the renderer is never initialized twice. A failed
 *   initialization leaves the game back in `"new"` and rethrows.
 * - `start()` is only valid from `"initialized"` and `"stopped"`; from
 *   `"running"` it is a no-op; any other state throws {@link GameError}.
 * - `stop()` is always safe: it cancels the pending frame and transitions
 *   `"running"` to `"stopped"`; in every other state it is a no-op, except
 *   during pending initialization where it marks the game to enter
 *   `"stopped"` once initialization completes (the loop never starts).
 * - `dispose()` is idempotent and terminal. It stops the loop, waits for any
 *   in-flight initialization, then disposes the renderer if it was
 *   initialized. Errors from renderer disposal are rethrown after the game is
 *   marked disposed. After disposal, `init()` and `start()` throw
 *   {@link GameError}; `stop()` and `dispose()` are safe no-ops.
 */
export class Game {
  readonly #renderer: Renderer;
  readonly #initOptions: RendererInitOptions;
  readonly #onUpdate: ((deltaTime: number) => void) | undefined;
  readonly #maxDeltaTime: number;
  readonly #scheduler: FrameScheduler;

  #state: GameState = "new";
  #initPromise: Promise<void> | null = null;
  #stopRequestedDuringInit = false;
  #disposePromise: Promise<void> | null = null;
  #lastTimestampMs: number | null = null;

  constructor(options: GameOptions) {
    if (!options.renderer) {
      throw new GameError("Game requires a renderer.");
    }
    if (!options.canvas) {
      throw new GameError("Game requires a canvas.");
    }
    if (
      options.maxDeltaTime !== undefined &&
      (!Number.isFinite(options.maxDeltaTime) || options.maxDeltaTime <= 0)
    ) {
      throw new GameError("maxDeltaTime must be a finite number greater than zero seconds.");
    }
    if ((options.width === undefined) !== (options.height === undefined)) {
      throw new GameError("Game requires both width and height, or neither.");
    }
    if (
      (options.width !== undefined && (!Number.isFinite(options.width) || options.width <= 0)) ||
      (options.height !== undefined && (!Number.isFinite(options.height) || options.height <= 0))
    ) {
      throw new GameError("width and height must be finite numbers greater than zero.");
    }

    this.#renderer = options.renderer;
    this.#initOptions = {
      canvas: options.canvas,
      backgroundColor: options.backgroundColor,
      resolution: options.resolution,
      ...(options.width === undefined && options.height === undefined
        ? {}
        : { width: options.width, height: options.height }),
    };
    this.#onUpdate = options.onUpdate;
    this.#maxDeltaTime = options.maxDeltaTime ?? 0.25;
    this.#scheduler = options.scheduler ?? createRequestAnimationFrameScheduler();
  }

  /** Current lifecycle state of the game. */
  get state(): GameState {
    return this.#state;
  }

  /** The renderer this game owns. */
  get renderer(): Renderer {
    return this.#renderer;
  }

  /**
   * Initialize the renderer. Concurrent calls return the same in-flight
   * promise. On failure the game returns to the `"new"` state and the error
   * is rethrown; initialization may then be retried.
   */
  init(): Promise<void> {
    if (this.#state === "initializing" && this.#initPromise !== null) {
      return this.#initPromise;
    }
    if (this.#state === "disposed") {
      return Promise.reject(new GameError("Cannot init a disposed game."));
    }
    if (this.#state !== "new") {
      return Promise.reject(
        new GameError(`init() is only valid from the "new" state, not "${this.#state}".`),
      );
    }

    this.#state = "initializing";
    this.#stopRequestedDuringInit = false;
    this.#initPromise = this.#initialize();
    return this.#initPromise;
  }

  async #initialize(): Promise<void> {
    try {
      await this.#renderer.initialize(this.#initOptions);
    } catch (error) {
      this.#state = "new";
      this.#initPromise = null;
      throw error;
    }
    this.#initPromise = null;
    if (this.#stopRequestedDuringInit) {
      this.#state = "stopped";
      return;
    }
    this.#state = "initialized";
  }

  /**
   * Start the frame loop. No-op when already running; throws
   * {@link GameError} in states that do not allow starting.
   */
  start(): void {
    if (this.#state === "running") {
      return;
    }
    if (this.#state === "initialized" || this.#state === "stopped") {
      this.#state = "running";
      this.#lastTimestampMs = null;
      this.#scheduleFrame();
      return;
    }
    if (this.#state === "new") {
      throw new GameError("Cannot start before initialization. Call and await init() first.");
    }
    if (this.#state === "initializing") {
      throw new GameError("Cannot start while initialization is pending. Await init() first.");
    }
    throw new GameError("Cannot start a disposed game.");
  }

  /**
   * Stop the frame loop. Safe to call repeatedly and in any state: from
   * `"running"` it cancels the pending frame and transitions to `"stopped"`;
   * during pending initialization it marks the game to stop once
   * initialization completes; in all other states it is a no-op.
   */
  stop(): void {
    if (this.#state === "initializing") {
      this.#stopRequestedDuringInit = true;
      return;
    }
    if (this.#state === "running") {
      this.#scheduler.cancelFrame();
      this.#state = "stopped";
    }
  }

  /**
   * Stop the loop and dispose the renderer. Idempotent: repeated calls return
   * the first disposal's promise. Waits for in-flight initialization before
   * disposing. Errors from renderer disposal are rethrown after the game is
   * marked disposed.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#scheduler.cancelFrame();
    if (this.#state === "initializing" && this.#initPromise !== null) {
      this.#stopRequestedDuringInit = true;
      // Initialization failure is not a disposal failure; the renderer was
      // never initialized and there is nothing extra to release.
      await this.#initPromise.catch(() => {});
    }
    this.#state = "disposed";
    if (this.#renderer.initialized) {
      await this.#renderer.dispose();
    }
  }

  #scheduleFrame(): void {
    this.#scheduler.requestFrame(this.#tick);
  }

  readonly #tick: FrameRequestCallback = (timestampMs: number): void => {
    if (this.#state !== "running") {
      return;
    }

    const lastTimestampMs = this.#lastTimestampMs;
    const deltaSeconds =
      lastTimestampMs === null
        ? 0
        : Math.min((timestampMs - lastTimestampMs) / 1000, this.#maxDeltaTime);
    this.#lastTimestampMs = timestampMs;

    try {
      this.#onUpdate?.(deltaSeconds);
    } catch (error) {
      // A fatal update error stops the loop; the error is rethrown to the
      // scheduler so it is never silently swallowed.
      this.#scheduler.cancelFrame();
      this.#state = "stopped";
      throw error;
    }

    if (this.#state !== "running") {
      // The update callback stopped or disposed the game synchronously.
      return;
    }
    this.#renderer.render?.();
    this.#scheduleFrame();
  };
}
