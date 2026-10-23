/**
 * Callback invoked for a scheduled frame with the scheduler's timestamp in
 * milliseconds (for `requestAnimationFrame`, the time of the frame start).
 */
export type FrameRequestCallback = (timestampMs: number) => void;

/**
 * Scheduling abstraction used by `Game` for its frame loop.
 *
 * The default implementation is backed by `requestAnimationFrame`. Tests
 * inject a deterministic fake to drive frames without real time or a browser.
 * Only one frame callback may be outstanding at a time; `cancelFrame` must
 * cancel it if one is pending, and must be safe to call when none is.
 */
export interface FrameScheduler {
  /** Schedule the next frame callback. */
  requestFrame(callback: FrameRequestCallback): void;
  /** Cancel the pending frame callback, if any. */
  cancelFrame(): void;
}
