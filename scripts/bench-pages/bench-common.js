// Shared workload definition for the cross-framework runtime benchmark
// (R13 acceptance criterion 4): N independently animated sprites on a 640×360
// stage, driven by the same math on every framework page so the comparison
// measures the framework, not the scene.
//
// The math mirrors the g2w benchmark page (examples/hello-world/src/bench-main.ts):
// each sprite orbits the center on a phase-offset path and rotates continuously.
// Position and rotation are pure functions of the clock, so every framework's
// per-frame update does the same number of writes.

export const VIEW_WIDTH = 640;
export const VIEW_HEIGHT = 360;

/** Counters the harness polls; same shape the g2w page exposes. */
export function createCounters(sprites) {
  const counters = {
    ready: false,
    sprites,
    frames: 0,
    frameMsTotal: 0,
    ring: [],
    lastTick: performance.now(),
  };
  window.__fwBench = counters;
  return counters;
}

/** One frame's bookkeeping: interval stats plus the ready flag. */
export function markFrame(counters) {
  const now = performance.now();
  const frameMs = now - counters.lastTick;
  counters.lastTick = now;
  counters.frames += 1;
  counters.frameMsTotal += frameMs;
  if (counters.ring.length >= 900) counters.ring.shift();
  counters.ring.push(frameMs);
  if (!counters.ready && counters.frames >= 2) counters.ready = true;
}

/** The shared orbit: position and rotation for one sprite at clock time `age`. */
export function orbit(age, phase) {
  const radius = 120 + 40 * Math.sin(age + phase);
  return {
    x: VIEW_WIDTH / 2 + Math.cos(age * 0.8 + phase) * radius,
    y: VIEW_HEIGHT / 2 + Math.sin(age * 1.3 + phase) * radius * 0.6,
    rotation: age * 2,
  };
}

/** ?sprites=N (capped at 50,000), matching the g2w benchmark page. */
export function spriteCountFromUrl() {
  const value = Number.parseInt(
    new URLSearchParams(window.location.search).get("sprites") ?? "1000",
    10,
  );
  if (!Number.isInteger(value) || value <= 0 || value > 50_000) {
    throw new Error(`bench: invalid ?sprites value`);
  }
  return value;
}

/** The shared 8×8 texture source — no network, no asset loading. */
export function makeTileCanvas() {
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const context = tile.getContext("2d");
  if (context === null) throw new Error("bench: 2d context unavailable");
  context.fillStyle = "#ffd166";
  context.fillRect(0, 0, 8, 8);
  return tile;
}

/** Surface setup failures in the DOM so the headless harness fails fast. */
export function showError(error) {
  const box = document.querySelector("#bench-error");
  if (box !== null) {
    box.textContent = `bench error:\n${error instanceof Error ? error.message : String(error)}`;
    box.hidden = false;
  }
  console.error(error);
}
