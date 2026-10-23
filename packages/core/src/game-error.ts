/**
 * Error thrown when a `Game` method is called in a state that does not allow
 * it, e.g. starting before initialization or starting after disposal.
 */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}
