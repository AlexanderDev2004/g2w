import type { GamepadSnapshot, GamepadState } from "@g2w/core";

/**
 * Error thrown for invalid `GamepadInput` lifecycle usage.
 */
export class GamepadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GamepadInputError";
  }
}

/**
 * Structural view of one polled gamepad. Deliberately narrower than the DOM
 * `Gamepad` type — only the fields the adapter consumes — so tests can pass
 * plain objects and the browser's real `navigator.getGamepads()` result is
 * structurally compatible.
 */
export interface PolledGamepad {
  /** Hardware slot index; stable only while the controller stays connected. */
  readonly index: number;
  /** Pressed state per button, indexed by standard button index. */
  readonly pressed: readonly boolean[];
  /** Analog axis values, indexed by standard axis index. Unnormalized. */
  readonly axes: readonly number[];
}

/** Polling source: returns every slot, `null` for vacant ones. */
export type GamepadSource = () => readonly (PolledGamepad | null)[];

/** Options for constructing a {@link GamepadInput}. */
export interface GamepadInputOptions {
  /**
   * Where controller samples come from. Defaults to the browser Gamepad API
   * (`navigator.getGamepads()`), mapped to the structural view. Inject a
   * fake source for deterministic tests — importing this package never
   * requires gamepad hardware to exist.
   */
  readonly source?: GamepadSource;
  /**
   * Target for `gamepadconnected` events. Defaults to `window`. Inject an
   * `EventTarget` fake for deterministic tests.
   */
  readonly connectTarget?: EventTarget;
  /** Target for `gamepaddisconnected` events. Defaults to `window`. */
  readonly disconnectTarget?: EventTarget;
}

interface ListenerRegistration {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListener;
}

function defaultSource(): readonly (PolledGamepad | null)[] {
  return [...navigator.getGamepads()].map((gamepad) =>
    gamepad === null
      ? null
      : {
          index: gamepad.index,
          pressed: [...gamepad.buttons].map((button) => button.pressed),
          axes: [...gamepad.axes],
        },
  );
}

/**
 * Browser gamepad adapter: samples controller state and feeds it into a core
 * {@link GamepadState}. It owns no polling loop and no timers — sampling is
 * explicit: call `poll()` once per game frame from the host's update path
 * (typically right before consumers read the state, mirroring how
 * `InputState` is fed by events and drained by `endFrame()`).
 *
 * Sampling policy:
 * - `poll()` feeds a sample for every present controller and treats any
 *   previously connected index that is now absent as disconnected, so stale
 *   button/axis state is never retained for a slot whose controller
 *   vanished without a `gamepaddisconnected` event.
 * - The default source reads `navigator.getGamepads()`; if the browser
 *   throws (some browsers do until a controller is interacted with), the
 *   error propagates to the caller and the state is left untouched — the
 *   next `poll()` simply retries. Errors are never swallowed.
 * - Axes are passed through raw: no dead zone, no normalization. Apply
 *   game-specific thresholds at the call site.
 * - Edge states live in `GamepadState` and are per game frame: sample as
 *   often as you like between two `GamepadState.endFrame()` calls.
 *
 * Lifecycle policy:
 * - `attach()` is idempotent; repeated calls never duplicate listeners.
 *   A registration that fails part-way through is rolled back completely —
 *   every listener added during that call is removed and the adapter stays
 *   detached and retryable. If a rollback removal itself fails, that
 *   listener is retained for disposal so `dispose()` can retry the removal;
 *   the original registration error is rethrown, aggregated with the
 *   cleanup failures.
 *   `attach()` registers the connection events; it does not poll.
 * - `dispose()` removes every listener this adapter registered, is
 *   idempotent, and is terminal — a disposed adapter cannot attach again
 *   and `poll()` rejects further sampling; every successfully removed
 *   listener stops delivering events, so the state sees nothing after
 *   disposal unless a removal itself failed.
 *   Disposal does not clear the state; the state is owned by the caller.
 *
 * Ownership: the caller owns the `GamepadState`, this adapter, and any
 * `Game`. A typical teardown order is this adapter first (no further
 * samples reach the state), then scenes, then the game.
 */
export class GamepadInput {
  readonly #state: GamepadState;
  readonly #options: GamepadInputOptions;
  readonly #registrations: ListenerRegistration[] = [];

  #attached = false;
  #disposed = false;

  constructor(state: GamepadState, options: GamepadInputOptions = {}) {
    this.#state = state;
    this.#options = options;
  }

  /**
   * Subscribe to connection events. Idempotent: calling it again while
   * attached is a no-op. Throws {@link GamepadInputError} after disposal.
   * Connection events only mark connectivity in the state; samples come
   * exclusively from `poll()`. Default event targets resolve to `window`
   * here rather than in the constructor, so constructing the adapter never
   * requires a browser environment.
   *
   * Failure-safe: if a listener registration fails part-way through, every
   * listener already registered during this call is removed before the
   * original error is rethrown, leaving the adapter detached and retryable.
   * A rollback failure is aggregated with the registration error
   * (`AggregateError`) instead of masking it.
   */
  attach(): void {
    if (this.#disposed) {
      throw new GamepadInputError("Cannot attach a disposed GamepadInput.");
    }
    if (this.#attached) {
      return;
    }

    // Register into a local list first and commit only on full success, so
    // a partial failure never leaves the adapter half-attached.
    const registrations: ListenerRegistration[] = [];
    try {
      this.#attachListeners(registrations);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const failedRemovals: ListenerRegistration[] = [];
      for (const { target, type, listener } of registrations) {
        try {
          target.removeEventListener(type, listener);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
          failedRemovals.push({ target, type, listener });
        }
      }
      if (cleanupErrors.length > 0) {
        // A failed removal means the listener may still be attached, and
        // its registration never entered #registrations. Retain it so a
        // later dispose() retries the removal (removing an already-removed
        // listener from an EventTarget is a no-op); without this the
        // listener would be unreachable — still mutating the state — for
        // the adapter's life.
        this.#registrations.push(...failedRemovals);
        throw new AggregateError(
          [error, ...cleanupErrors],
          "GamepadInput attach failed and listener rollback failed.",
        );
      }
      throw error;
    }
    this.#registrations.push(...registrations);
    this.#attached = true;
  }

  #attachListeners(registrations: ListenerRegistration[]): void {
    const connectTarget = this.#options.connectTarget ?? window;
    const disconnectTarget = this.#options.disconnectTarget ?? window;

    const register = (target: EventTarget, type: string, handler: (event: Event) => void): void => {
      const listener: EventListener = (event) => handler(event);
      target.addEventListener(type, listener);
      registrations.push({ target, type, listener });
    };

    register(connectTarget, "gamepadconnected", (event) => {
      const index = (event as GamepadEvent).gamepad?.index;
      if (typeof index === "number") {
        this.#state.handleConnected(index);
      }
    });
    register(disconnectTarget, "gamepaddisconnected", (event) => {
      const index = (event as GamepadEvent).gamepad?.index;
      if (typeof index === "number") {
        this.#state.handleDisconnected(index);
      }
    });
  }

  /**
   * Sample every controller once and feed the results into the state.
   * Present controllers are sampled; connected indices absent from the
   * source's result are treated as disconnected. Throws if the source
   * throws (see the sampling policy) or after disposal — sampling stays
   * caller-driven and can never mutate the state once the adapter is
   * disposed.
   */
  poll(): void {
    if (this.#disposed) {
      throw new GamepadInputError("Cannot poll a disposed GamepadInput.");
    }
    const source = this.#options.source ?? defaultSource;
    const gamepads = source();
    const present = new Set<number>();
    for (const gamepad of gamepads) {
      if (gamepad === null) {
        continue;
      }
      present.add(gamepad.index);
      this.#state.handleSample(gamepad.index, {
        pressed: gamepad.pressed,
        axes: gamepad.axes,
      } satisfies GamepadSnapshot);
    }
    for (const index of this.#state.connectedIndices()) {
      if (!present.has(index)) {
        this.#state.handleDisconnected(index);
      }
    }
  }

  /**
   * Remove every listener this adapter registered. Idempotent and terminal:
   * later calls are no-ops and the adapter cannot attach again.
   *
   * Every removal is attempted even if one fails; failures are collected
   * into an `AggregateError` instead of silently abandoning the remaining
   * listeners. Listeners whose attach-time rollback removal failed are
   * retained and retried here — re-removing an already-removed listener is
   * a no-op. The adapter stays disposed regardless.
   *
   * Disposal does not clear the state; the state is owned by the caller.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#attached = false;
    const cleanupErrors: unknown[] = [];
    for (const { target, type, listener } of this.#registrations) {
      try {
        target.removeEventListener(type, listener);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    this.#registrations.length = 0;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "GamepadInput dispose failed to remove some listeners.",
      );
    }
  }

  /** Whether the adapter is currently attached to its event targets. */
  get attached(): boolean {
    return this.#attached;
  }
}
