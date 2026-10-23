/**
 * Error thrown when a `SceneManager` method is called in a state that does
 * not allow it, e.g. transitioning before start, requesting an unknown scene,
 * or updating after disposal. Errors thrown by scene hooks themselves are not
 * wrapped; they propagate unchanged to the caller.
 */
export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}
