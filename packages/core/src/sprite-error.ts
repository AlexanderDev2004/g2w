/**
 * Error thrown when the core sprite model is used against its documented
 * contract, e.g. an anchor coordinate outside the normalized range.
 */
export class SpriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpriteError";
  }
}
