import type { FrameRequestCallback, FrameScheduler } from "./frame-scheduler.js";

/**
 * Internal default `FrameScheduler` backed by `requestAnimationFrame`.
 * Browser-only: accessed lazily so importing this module stays safe in Node.
 */
export function createRequestAnimationFrameScheduler(): FrameScheduler {
  let handle: number | null = null;

  return {
    requestFrame(callback: FrameRequestCallback): void {
      handle = requestAnimationFrame((timestampMs) => {
        handle = null;
        callback(timestampMs);
      });
    },
    cancelFrame(): void {
      if (handle !== null) {
        cancelAnimationFrame(handle);
        handle = null;
      }
    },
  };
}
