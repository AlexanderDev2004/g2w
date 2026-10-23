/**
 * A named, reusable unit of game logic managed by a {@link SceneManager}.
 *
 * All hooks are optional and synchronous. Scenes acquire resources in `init`
 * or `enter` and release them in `exit` or `dispose`; the manager drives the
 * hooks in a fixed order (see `SceneManager` for the full lifecycle and
 * transition semantics).
 *
 * Errors thrown by a hook are never wrapped or swallowed: they propagate to
 * whichever call triggered the hook (the game loop stops if that call is a
 * frame update, matching `Game`'s `onUpdate` contract).
 */
export interface Scene {
  /**
   * Called at most once per scene instance, lazily, the first time the scene
   * is activated. A failed `init` may be retried by activating the scene
   * again; `enter` is not called unless `init` completes.
   */
  init?(): void;
  /** Called every time the scene becomes the active scene. */
  enter?(): void;
  /**
   * Called once per frame with the elapsed time in seconds while the scene is
   * the active scene. The manager forwards the value it receives; clamping is
   * the caller's concern (`Game` already clamps to `maxDeltaTime`).
   */
  update?(deltaTime: number): void;
  /**
   * Called when the scene stops being the active scene. Paired with every
   * successful `enter`, including when the manager is disposed.
   */
  exit?(): void;
  /**
   * Called once when the owning `SceneManager` is disposed, but only for
   * scenes whose `init` completed; a scene that was never initialized has no
   * manager-managed resources to release.
   */
  dispose?(): void;
}
