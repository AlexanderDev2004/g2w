import { SceneError } from "./scene-error.js";
import { Transform2D } from "./sprite.js";

/**
 * A minimal, renderer-agnostic game object: a {@link Transform2D} plus
 * optional update and cleanup hooks, managed by a {@link GameObjectCollection}.
 *
 * Like `Scene`, this is a plain-object contract — game code defines objects as
 * object literals, and every hook is optional and synchronous:
 *
 * ```ts
 * const enemy: GameObject = {
 *   transform: new Transform2D({ x: 100, y: 50 }),
 *   update(deltaTime) {
 *     this.transform.x += 40 * deltaTime;
 *   },
 *   destroy() {
 *     // release resources the object itself created (e.g. its sprite view)
 *   },
 * };
 * ```
 *
 * A game object is pure gameplay state; it never requires a visual. To render
 * one, compose it with a `Sprite2D` that shares its transform (or points at
 * the same `Transform2D` instance) and create a sprite view for that sprite at
 * the adapter boundary — core has no display-object concept and never touches
 * textures. The `destroy` hook is the place to dispose the view the object
 * created; it must never destroy shared textures (see the R1 ownership
 * policy: framework cleanup never destroys shared-cache textures).
 *
 * An object belongs to at most one collection at a time; removing it releases
 * the claim so it can be added elsewhere. Once destroyed through a collection,
 * the claim is permanent — the same instance can never be registered again
 * (create a new object instead), mirroring the one-manager-per-scene rule.
 */
export interface GameObject {
  /** Position, rotation, and scale of the object. Several objects may share one transform. */
  readonly transform: Transform2D;
  /**
   * Called once per frame with the elapsed time in seconds, in registration
   * order, while the object is registered and its collection is updated.
   */
  update?(deltaTime: number): void;
  /**
   * Called once when the owning collection is destroyed. Best-effort: one
   * object's failure does not prevent the remaining cleanups.
   */
  destroy?(): void;
}

/**
 * The collection a game object is currently registered with, and the set of
 * objects already destroyed through a collection. Both are keyed weakly, so
 * they never keep objects alive.
 */
const owners = new WeakMap<GameObject, GameObjectCollection>();
const destroyedObjects = new WeakSet<GameObject>();

/**
 * Owns a set of {@link GameObject}s for one scene and updates them in
 * registration order. Composes with the existing lifecycle — a scene owns a
 * collection, forwards frames from its `update` hook, and destroys the
 * collection in its `dispose` hook. No scene or game API changes, and there
 * is no second loop:
 *
 * ```ts
 * const gameplayScene: Scene = {
 *   update(deltaTime) {
 *     objects.update(deltaTime);
 *   },
 *   dispose() {
 *     objects.destroy();
 *   },
 * };
 * ```
 *
 * Lifecycle and iteration policy (all of it is tested):
 * - **Registration** is explicit: `add` registers an object that is not
 *   currently registered anywhere and has not been destroyed; duplicates
 *   throw {@link SceneError}. Objects update in insertion order starting with
 *   the next update.
 * - **Removal** (`remove`) detaches the object and releases the claim without
 *   calling its `destroy` hook — the caller takes back ownership of the
 *   object and its resources. Removing an unregistered object throws
 *   {@link SceneError}.
 * - **Mid-update mutations are safe**: `add` during an update takes effect
 *   from the next update; `remove` during an update takes effect immediately
 *   — the removed object is skipped for the rest of that update. Iteration
 *   runs over a snapshot, so neither operation can corrupt the loop.
 * - **Nested `update`** (calling `update` from inside an object hook) throws
 *   {@link SceneError}: one frame must never update an object twice.
 * - **Hook errors** are never wrapped: a throw propagates to the caller of
 *   `update` unchanged (stopping the game loop, matching the `Scene.update`
 *   contract). The collection's own state stays consistent.
 * - **Destruction** (`destroy`) is immediate, idempotent, and terminal: every
 *   still-registered object's `destroy` hook runs exactly once in insertion
 *   order; objects removed earlier are left to their caller. Cleanup is
 *   best-effort — one hook's failure does not prevent the remaining hooks,
 *   and the first error is rethrown, as an {@link AggregateError} when several
 *   hooks fail, after all cleanup attempts complete. Afterwards `add`,
 *   `remove`, and `update` throw {@link SceneError}, and destroyed objects can
 *   never be registered again.
 * - **Ownership**: the collection manages references, not resources. It never
 *   touches textures, views, or anything else an object refers to; an object's
 *   `destroy` hook releases what the object itself created.
 */
export class GameObjectCollection {
  #members = new Set<GameObject>();
  #destroyed = false;
  #updating = false;

  /** Number of currently registered objects. */
  get size(): number {
    return this.#members.size;
  }

  /**
   * A snapshot of the currently registered objects, in insertion order. The
   * returned array is a fresh copy: mutating it has no effect on the
   * collection, and later changes are not reflected in it. Intended for
   * diagnostics and inspection tools (e.g. `@g2w/devtools`); game logic should
   * not need it.
   */
  objects(): readonly GameObject[] {
    if (this.#destroyed) {
      throw new SceneError("Cannot read objects from a destroyed collection.");
    }
    return [...this.#members];
  }

  /**
   * Register an object. Throws {@link SceneError} after disposal, for invalid
   * objects, for an object already registered (here or in another collection),
   * and for an object destroyed through any collection.
   */
  add(object: GameObject): void {
    if (this.#destroyed) {
      throw new SceneError("Cannot add objects to a destroyed collection.");
    }
    if (object === null || typeof object !== "object") {
      throw new SceneError("GameObjectCollection.add requires a game object.");
    }
    if (!(object.transform instanceof Transform2D)) {
      throw new SceneError(
        "GameObjectCollection.add requires an object with a Transform2D transform.",
      );
    }
    if (destroyedObjects.has(object)) {
      throw new SceneError(
        "Cannot add a destroyed game object to a collection. Create a new object instead.",
      );
    }
    const owner = owners.get(object);
    if (owner !== undefined) {
      throw new SceneError(
        "Game object is already registered with a GameObjectCollection. " +
          "Remove it there first, or create a new instance.",
      );
    }
    owners.set(object, this);
    this.#members.add(object);
  }

  /**
   * Detach a registered object without calling its `destroy` hook and release
   * its claim: the caller owns the object again and may register it elsewhere.
   * Throws {@link SceneError} after disposal or when the object is not
   * registered. During an update the removal takes effect immediately.
   */
  remove(object: GameObject): void {
    if (this.#destroyed) {
      throw new SceneError("Cannot remove objects from a destroyed collection.");
    }
    if (!this.#members.has(object)) {
      throw new SceneError("Cannot remove an object that is not registered.");
    }
    this.#members.delete(object);
    owners.delete(object);
  }

  /**
   * Update every registered object in insertion order with the elapsed time
   * in seconds. Throws {@link SceneError} after disposal or when called from
   * inside an object hook (nested update). Hook errors propagate unchanged;
   * the collection's state stays consistent.
   */
  update(deltaTime: number): void {
    if (this.#destroyed) {
      throw new SceneError("Cannot update a destroyed collection.");
    }
    if (this.#updating) {
      throw new SceneError(
        "Cannot update a collection from inside one of its object hooks (nested update).",
      );
    }
    // Iterate a snapshot: add/remove during the loop mutate the live set, not
    // the snapshot, so the iteration can never be corrupted. Members removed
    // mid-update are skipped through the live-set membership check.
    const snapshot = [...this.#members];
    this.#updating = true;
    try {
      for (const object of snapshot) {
        if (!this.#members.has(object)) {
          continue;
        }
        object.update?.call(object, deltaTime);
      }
    } finally {
      this.#updating = false;
    }
  }

  /**
   * Destroy every still-registered object's `destroy` hook exactly once, in
   * insertion order. Best-effort: a hook that throws does not prevent the
   * remaining cleanups — every eligible hook is attempted exactly once. The
   * first error is rethrown as-is, or as an {@link AggregateError} when
   * several hooks fail, after all cleanup attempts have completed. Disposal is
   * immediate, idempotent, and terminal: later calls are no-ops, and
   * `add`, `remove`, and `update` throw {@link SceneError} afterwards.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    const errors: unknown[] = [];
    for (const object of [...this.#members]) {
      this.#members.delete(object);
      owners.delete(object);
      destroyedObjects.add(object);
      try {
        object.destroy?.call(object);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more game objects failed to clean up.");
    }
  }
}
