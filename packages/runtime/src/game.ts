import type { FrameRequestCallback, FrameScheduler } from "@g2w/core";
import {
  createRequestAnimationFrameScheduler,
  GameError,
  type GameState,
  type Renderer,
  type RendererInitOptions,
  type SceneManager,
} from "@g2w/core";
import { Effect } from "effect";
import { createG2WRuntime, type G2WFinalizer, type G2WRuntime } from "./runtime.js";

/** Options for constructing a {@link G2WGame}. */
export interface G2WGameOptions {
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
   * scheduler. Intended for tests to drive frames deterministically. The
   * game owns exactly this one scheduler; the Effect runtime is never
   * involved in the frame hot path.
   */
  readonly scheduler?: FrameScheduler;
  /**
   * An optional `SceneManager` whose disposal the game owns. When provided
   * (and `ownScenes` is not `false`), the game registers the manager's
   * disposal as a runtime finalizer on successful initialization, so
   * `dispose()` exits the active scene and disposes every initialized scene
   * before the renderer is released. Scene transitions and hooks themselves
   * stay synchronous in core; the managed runtime owns only the disposal
   * orchestration.
   */
  readonly scenes?: SceneManager;
  /**
   * Whether the game owns the disposal of the `scenes` manager. Defaults to
   * `true`. Set to `false` to keep the core contract where the caller
   * disposes the manager separately.
   */
  readonly ownScenes?: boolean;
}

/**
 * Effect-native game lifecycle: the same state machine and frame-loop
 * behavior as core `Game`, with initialization, resource ownership, and
 * disposal orchestrated through the managed Effect runtime from E1
 * (`createG2WRuntime`).
 *
 * State-transition policy (identical to core `Game`, all of it tested):
 * - `init()` is only valid from `"new"`; concurrent calls share the same
 *   in-flight promise, so the renderer is never initialized twice. A failed
 *   initialization leaves the game back in `"new"` and rethrows the original
 *   error; initialization may then be retried.
 * - `start()` is only valid from `"initialized"` and `"stopped"`; from
 *   `"running"` it is a no-op; any other state throws {@link GameError}.
 * - `stop()` is always safe: from `"running"` it cancels the pending frame
 *   and transitions to `"stopped"`; during pending initialization it marks
 *   the game to enter `"stopped"` once initialization completes; in every
 *   other state it is a no-op.
 * - `dispose()` is idempotent and terminal. It stops the loop, waits for any
 *   in-flight initialization, marks the game disposed, then shuts the game's
 *   managed runtime down. Cleanup runs exactly once in LIFO order — user
 *   finalizers first, then scene disposal, then renderer release — and every
 *   finalizer is attempted even after a failure. Cleanup failures are never
 *   swallowed: `dispose()` rejects with Effect's `RuntimeShutdownError`
 *   carrying every failure (with original causes) after the game is marked
 *   disposed. After disposal, `init()` and `start()` throw {@link GameError};
 *   `stop()` and `dispose()` are safe no-ops.
 *
 * The frame loop stays entirely synchronous: one `FrameScheduler` owned by
 * the game, update and render dispatched inline, and no Effect runtime,
 * effect, or promise allocation anywhere in the per-frame path.
 */
export class G2WGame {
  readonly #renderer: Renderer;
  readonly #initOptions: RendererInitOptions;
  readonly #onUpdate: ((deltaTime: number) => void) | undefined;
  readonly #maxDeltaTime: number;
  readonly #scheduler: FrameScheduler;
  readonly #scenes: SceneManager | undefined;
  readonly #ownScenes: boolean;
  readonly #runtime: Promise<G2WRuntime<never>>;

  #runtimeHandle: G2WRuntime<never> | null = null;
  #pendingFinalizers: G2WFinalizer[] = [];
  #state: GameState = "new";
  #initPromise: Promise<void> | null = null;
  #stopRequestedDuringInit = false;
  #disposePromise: Promise<void> | null = null;
  #lastTimestampMs: number | null = null;
  #ownershipRegistered = false;

  constructor(options: G2WGameOptions) {
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
    this.#scenes = options.scenes;
    this.#ownScenes = options.scenes !== undefined && options.ownScenes !== false;
    // One managed Effect runtime owned by the game: it executes lifecycle
    // effects (renderer initialization) and owns the cleanup scope that
    // dispose() shuts down. Never allocated per frame. The empty-layer
    // bootstrap resolves on the next microtask; finalizers requested before
    // it resolves are buffered and flushed in registration order at init.
    this.#runtime = createG2WRuntime();
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
   * Register a cleanup callback executed exactly once when the game is
   * disposed. The game owns the finalizers; release order is LIFO and every
   * finalizer runs before the scene disposal and the renderer release,
   * regardless of when it was registered. Every finalizer is attempted even
   * if an earlier one fails, and failures stay observable through the
   * rejection of `dispose()`. Throws {@link GameError} after disposal.
   */
  addFinalizer(finalizer: G2WFinalizer): void {
    if (this.#state === "disposed") {
      throw new GameError("Cannot register a finalizer on a disposed game.");
    }
    if (this.#runtimeHandle !== null) {
      this.#runtimeHandle.addFinalizer(finalizer);
      return;
    }
    this.#pendingFinalizers.push(finalizer);
  }

  /**
   * Initialize the renderer through the managed Effect runtime. Concurrent
   * calls return the same in-flight promise. On failure the game returns to
   * the `"new"` state and the original error is rethrown; initialization
   * may then be retried. Rejected with {@link GameError} once disposal has
   * started — including the gap where a failed in-flight initialization has
   * already reset the state but disposal has not completed yet.
   */
  init(): Promise<void> {
    if (this.#state === "initializing" && this.#initPromise !== null) {
      return this.#initPromise;
    }
    // Disposal is terminal from the moment it starts, not only once it
    // completes: a failed initialization resets the state to "new" while
    // dispose() is still waiting for it, and a retry in that gap could
    // race the runtime shutdown and leave an initialized renderer with no
    // registered cleanup.
    if (this.#state === "disposed" || this.#disposePromise !== null) {
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
    const runtime = await this.#runtime;
    try {
      // The single lifecycle effect: acquire the renderer through the one
      // managed runtime. `Effect.promise` rethrows the original rejection,
      // so the failure cause is preserved unchanged.
      await runtime.run(Effect.promise(() => this.#renderer.initialize(this.#initOptions)));
    } catch (error) {
      // Nothing was acquired on failure, so there is nothing to roll back:
      // the renderer was never initialized and no ownership finalizer was
      // registered. The buffered caller finalizers stay pending.
      this.#state = "new";
      this.#initPromise = null;
      throw error;
    }
    this.#runtimeHandle = runtime;
    if (!this.#ownershipRegistered) {
      this.#ownershipRegistered = true;
      // Ownership is registered in acquisition order: renderer first, then
      // scenes, then every caller finalizer buffered so far. LIFO shutdown
      // therefore releases callers, then scenes, then the renderer they may
      // still be rendering with.
      const scenes = this.#scenes;
      runtime.addFinalizer(() => this.#renderer.dispose());
      if (this.#ownScenes && scenes !== undefined) {
        runtime.addFinalizer(() => scenes.dispose());
      }
    }
    this.#flushPendingFinalizers(runtime);
    this.#initPromise = null;
    if (this.#stopRequestedDuringInit) {
      this.#state = "stopped";
      return;
    }
    this.#state = "initialized";
  }

  #flushPendingFinalizers(runtime: G2WRuntime<never>): void {
    const pending = this.#pendingFinalizers;
    this.#pendingFinalizers = [];
    for (const finalizer of pending) {
      runtime.addFinalizer(finalizer);
    }
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
   * Stop the loop and dispose everything the game owns. Idempotent:
   * repeated and concurrent calls return the first disposal's promise.
   * Waits for in-flight initialization before disposing. Cleanup runs
   * through the managed runtime's shutdown: every finalizer is attempted,
   * and the first failure is rethrown (aggregated with the rest when
   * several fail) after the game is marked disposed.
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
      // never initialized and nothing was registered for it.
      await this.#initPromise.catch(() => {});
    }
    this.#state = "disposed";
    const runtime = await this.#runtime;
    if (this.#runtimeHandle === null) {
      // Initialization never completed: the game owns no renderer or scene
      // resources. Buffered caller finalizers still run, in LIFO order.
      this.#flushPendingFinalizers(runtime);
    }
    await runtime.shutdown();
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
