/**
 * Error thrown for invalid `AudioManager` lifecycle or usage errors.
 * Backend load failures are never wrapped: they propagate to the caller
 * unchanged, exactly like asset loader failures.
 */
export class AudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioError";
  }
}
