import type { Scene } from "./scene.js";
import { SceneError } from "./scene-error.js";

/**
 * Scenes already claimed by a `SceneManager`. A scene instance belongs to
 * exactly one manager for its lifetime — see the ownership note on
 * {@link Scene}. The claim is made at registration and never released, even
 * when the owning manager is disposed.
 */
const claimedScenes = new WeakSet<Scene>();

/** Options for constructing a {@link SceneManager}. */
export interface SceneManagerOptions {
  /**
   * The scenes by name. Names must be non-empty unique record keys holding
   * scene objects; the manager drives their lifecycle from here on.
   */
  readonly scenes: Readonly<Record<string, Scene>>;
  /** Name of the scene `start()` activates first. Must be registered. */
  readonly initial: string;
}

interface SceneEntry {
  readonly name: string;
  readonly scene: Scene;
  /** Set once `init` has completed successfully; `init` never runs again. */
  initialized: boolean;
}

/**
 * Owns the lifecycle of a fixed set of named scenes and updates only the
 * active one. Composes with `Game` by being driven from its `onUpdate`
 * callback — the manager runs no frame loop of its own:
 *
 * ```ts
 * const scenes = new SceneManager({ scenes: { menu, gameplay }, initial: "menu" });
 * const game = new Game({ renderer, canvas, onUpdate: (dt) => scenes.update(dt) });
 * await game.init();
 * scenes.start();
 * game.start();
 * ```
 *
 * Lifecycle and transition policy (all of it is tested):
 * - **Init** runs at most once per scene instance, lazily on first activation.
 *   A failed `init` may be retried; `enter` never runs unless `init` completed.
 * - **Activation order** is deterministic: `init` (first activation only),
 *   then `enter`. A scene becomes active only after `enter` returns.
 * - **Transitions** exit the previous scene before entering the next one. They
 *   apply immediately, except when requested from inside a running scene hook
 *   (`update`, `enter`, `exit`), where they are deferred to the start of the
 *   next `update` — the current update finishes on the scene that requested
 *   the change. The most recent request always wins: it replaces any pending
 *   deferred transition, and requesting the already-active scene cancels a
 *   pending one and is otherwise a no-op. Unknown names throw
 *   {@link SceneError} without changing any state.
 * - **Hook errors** are not wrapped: a throw propagates to the caller of
 *   `start`, `goTo`, or `update` unchanged. The manager keeps its own state
 *   consistent: after a failed transition it has no active scene, the failed
 *   scene receives no `exit` (it never completed `enter`), and a later
 *   `goTo` to any registered scene recovers normally.
 * - **Disposal** is immediate, idempotent, and terminal: the active scene is
 *   exited, then every scene whose `init` completed is disposed in
 *   registration order (scenes never initialized are left untouched). Cleanup
 *   is best-effort: one hook's failure does not prevent the remaining hooks,
 *   and the first error is rethrown — as an {@link AggregateError} when
 *   several hooks fail — after all cleanup attempts complete. Afterwards
 *   `start`, `goTo`, and `update` throw {@link SceneError}.
 *
 * Intentionally unsupported: async hooks, scene stacks, transition effects,
 * constructor-time or `start`-time scene replacement, and sharing a scene
 * instance between managers — registering a scene object that another
 * `SceneManager` (or another name in the same record) already claims throws
 * {@link SceneError}. The claim is permanent: it is not released when the
 * owning manager is disposed, because that manager's disposal is terminal
 * for the scenes it owns.
 */
export class SceneManager {
  readonly #entries: Map<string, SceneEntry>;
  readonly #initialEntry: SceneEntry;

  #started = false;
  #disposed = false;
  #active: SceneEntry | null = null;
  #pending: SceneEntry | null = null;
  #inHook = false;

  constructor(options: SceneManagerOptions) {
    if (options.scenes === null || typeof options.scenes !== "object") {
      throw new SceneError("SceneManager requires a scenes record.");
    }
    const names = Object.keys(options.scenes);
    if (names.length === 0) {
      throw new SceneError("SceneManager requires at least one scene.");
    }

    const entries = new Map<string, SceneEntry>();
    for (const name of names) {
      const scene = options.scenes[name];
      if (scene === undefined || scene === null || typeof scene !== "object") {
        throw new SceneError(`Scene "${name}" must be a scene object.`);
      }
      if (claimedScenes.has(scene)) {
        throw new SceneError(
          `Scene instance registered as "${name}" is already owned by a SceneManager. ` +
            "A scene instance belongs to exactly one manager for its lifetime; create a new instance instead.",
        );
      }
      claimedScenes.add(scene);
      entries.set(name, { name, scene, initialized: false });
    }

    const initialEntry = entries.get(options.initial);
    if (initialEntry === undefined) {
      throw new SceneError(
        `Initial scene "${options.initial}" is not registered. Registered scenes: ${names.join(", ")}.`,
      );
    }

    this.#entries = entries;
    this.#initialEntry = initialEntry;
  }

  /** Name of the currently active scene, or `null` when none is active. */
  get active(): string | null {
    return this.#active?.name ?? null;
  }

  /**
   * Activate the initial scene (`init` if needed, then `enter`). Throws
   * {@link SceneError} if the manager is started or disposed; a failed
   * activation leaves the manager unstarted so `start()` may be retried.
   */
  start(): void {
    if (this.#disposed) {
      throw new SceneError("Cannot start a disposed scene manager.");
    }
    if (this.#started) {
      throw new SceneError("SceneManager is already started.");
    }
    this.#started = true;
    try {
      this.#activate(this.#initialEntry);
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  /**
   * Request a transition to the named scene. The most recent request always
   * wins: it replaces any pending deferred transition, and requesting the
   * already-active scene cancels a pending one and is otherwise a no-op.
   * Unknown names throw {@link SceneError} without changing any state.
   * Requests made from inside a running scene hook are deferred to the start
   * of the next `update`.
   */
  goTo(name: string): void {
    if (this.#disposed) {
      throw new SceneError("Cannot transition in a disposed scene manager.");
    }
    if (!this.#started) {
      throw new SceneError("goTo() requires a started scene manager. Call start() first.");
    }
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new SceneError(
        `Unknown scene "${name}". Registered scenes: ${[...this.#entries.keys()].join(", ")}.`,
      );
    }
    // The latest request supersedes everything older, including requests that
    // are no-ops; an invalid (unknown) request never reaches this line and
    // therefore cannot disturb a pending transition.
    this.#pending = null;
    if (this.#active?.name === name) {
      return;
    }
    if (this.#inHook) {
      this.#pending = entry;
      return;
    }
    this.#transitionTo(entry);
  }

  /**
   * Apply any deferred transition, then update the active scene with the
   * elapsed time in seconds. Throws {@link SceneError} before start or after
   * disposal; a no-op when no scene is active (e.g. after a failed
   * transition) until a successful `goTo` recovers.
   */
  update(deltaTime: number): void {
    if (this.#disposed) {
      throw new SceneError("Cannot update a disposed scene manager.");
    }
    if (!this.#started) {
      throw new SceneError("update() requires a started scene manager. Call start() first.");
    }
    if (this.#pending !== null) {
      const entry = this.#pending;
      this.#pending = null;
      if (this.#active?.name !== entry.name) {
        this.#transitionTo(entry);
      }
    }
    const active = this.#active;
    if (active === null) {
      return;
    }
    this.#runUpdate(active, deltaTime);
  }

  /**
   * Exit the active scene and dispose every initialized scene in registration
   * order. Best-effort: a hook that throws does not prevent the remaining
   * cleanup — every eligible hook is attempted exactly once. The first error
   * is rethrown as-is, or as an {@link AggregateError} when several hooks
   * fail, after all cleanup attempts have completed. Disposal is immediate,
   * idempotent, and terminal: later calls are no-ops even when an error was
   * rethrown, and `start`, `goTo`, and `update` throw {@link SceneError}
   * afterwards. Disposing the manager does not stop a `Game` that drives it;
   * the caller owns both and must dispose each.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#pending = null;
    const errors: unknown[] = [];
    const active = this.#active;
    this.#active = null;
    if (active !== null) {
      try {
        this.#runLifecycleHook(active, "exit");
      } catch (error) {
        errors.push(error);
      }
    }
    for (const entry of this.#entries.values()) {
      if (entry.initialized) {
        try {
          this.#runLifecycleHook(entry, "dispose");
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more scenes failed to clean up during disposal.");
    }
  }

  #transitionTo(entry: SceneEntry): void {
    const previous = this.#active;
    // Clear before the exit hook so a failed exit still leaves the manager in
    // a consistent "no active scene" state.
    this.#active = null;
    if (previous !== null) {
      this.#runLifecycleHook(previous, "exit");
    }
    this.#activate(entry);
  }

  #activate(entry: SceneEntry): void {
    if (!entry.initialized) {
      this.#runLifecycleHook(entry, "init");
      // Only a completed init marks the scene initialized, so a failed init
      // can be retried on the next activation attempt.
      entry.initialized = true;
    }
    this.#runLifecycleHook(entry, "enter");
    // Active only after enter succeeds; a failed enter leaves no active scene.
    this.#active = entry;
  }

  #runLifecycleHook(entry: SceneEntry, hookName: "init" | "enter" | "exit" | "dispose"): void {
    const hook = entry.scene[hookName];
    if (hook === undefined) {
      return;
    }
    const wasInHook = this.#inHook;
    this.#inHook = true;
    try {
      hook.call(entry.scene);
    } finally {
      this.#inHook = wasInHook;
    }
  }

  #runUpdate(entry: SceneEntry, deltaTime: number): void {
    const hook = entry.scene.update;
    if (hook === undefined) {
      return;
    }
    const wasInHook = this.#inHook;
    this.#inHook = true;
    try {
      hook.call(entry.scene, deltaTime);
    } finally {
      this.#inHook = wasInHook;
    }
  }
}
