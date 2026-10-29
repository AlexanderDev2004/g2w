// R13 Phase 1: runtime benchmark harness (FPS, frame time, heap).
//
// Boots the hello-world Vite dev server, opens the benchmark page
// (bench.html?sprites=N) once per case in a fresh headless-Chrome page via
// the Chrome DevTools Protocol over a raw WebSocket (Node built-in
// WebSocket, no packages added), waits for the scene to be ready, then
// samples the page's counters over a fixed wall-clock window and reports
// FPS, average and p95 frame interval, and JS heap growth.
//
// Usage:
//   node scripts/benchmark-runtime.mjs
// Environment:
//   G2W_CHROME        absolute path to a Chrome/Chromium binary
//                     (default: C:/Program Files/Google/Chrome/Application/chrome.exe)
//   G2W_BENCH_PORT    dev-server port (default 5201); CDP port is +1
//   G2W_BENCH_SECONDS sampling window per case (default 10)
//   G2W_BENCH_CASES   comma-separated sprite counts (default 100,1000,5000)
//
// This is a hardware/browser-dependent benchmark harness: it is NOT part of
// the default `pnpm test` suite and needs a locally installed Chrome. Single
// run per case — re-run on quiet machines before comparing numbers.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.G2W_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEV_PORT = Number(process.env.G2W_BENCH_PORT ?? 5201);
const CDP_PORT = DEV_PORT + 1;
const WINDOW_SECONDS = Number(process.env.G2W_BENCH_SECONDS ?? 10);
const CASES = (process.env.G2W_BENCH_CASES ?? "100,1000,5000")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { attempts, intervalMs, description }) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

// --- Dev server -------------------------------------------------------------
console.log(`starting Vite dev server on port ${DEV_PORT}...`);
const vite = spawn(
  process.execPath,
  [
    path.join(repoRoot, "examples/hello-world/node_modules/vite/bin/vite.js"),
    "--port",
    String(DEV_PORT),
    "--strictPort",
  ],
  { cwd: path.join(repoRoot, "examples/hello-world"), stdio: ["ignore", "ignore", "inherit"] },
);
try {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://localhost:${DEV_PORT}/bench.html`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { attempts: 80, intervalMs: 250, description: "the Vite dev server" },
  );

  // --- Headless Chrome --------------------------------------------------------
  const profile = mkdtempSync(path.join(tmpdir(), "g2w-bench-"));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--disable-gpu",
      "--window-size=800,600",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitFor(
      async () => {
        try {
          const list = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json());
          return list.some((target) => target.type === "page");
        } catch {
          return false;
        }
      },
      { attempts: 60, intervalMs: 250, description: "headless Chrome CDP" },
    );

    const list = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json());
    const page = list.find((target) => target.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`CDP ${message.error.message}`));
        else resolve(message.result);
      }
    });
    function send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails)
        throw new Error(
          `page error: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`,
        );
      return result.result.value;
    }

    const rows = [];
    for (const sprites of CASES) {
      process.stdout.write(`[case] sprites=${sprites} ... `);
      await send("Page.navigate", {
        url: `http://localhost:${DEV_PORT}/bench.html?sprites=${sprites}`,
      });
      await waitFor(
        () =>
          evaluate(
            `(() => { const b = document.querySelector('#bench-error'); if (b && !b.hidden) throw new Error(b.textContent); return window.__g2wBench?.ready === true; })()`,
          ),
        { attempts: 200, intervalMs: 250, description: `the bench scene (${sprites} sprites)` },
      );
      // Small settle window so the first samples are steady-state.
      await sleep(2000);
      const start = await evaluate(
        `({ frames: window.__g2wBench.frames, heap: performance.memory?.usedJSHeapSize ?? null, at: performance.now() })`,
      );
      await sleep(WINDOW_SECONDS * 1000);
      const end = await evaluate(
        `({ frames: window.__g2wBench.frames, heap: performance.memory?.usedJSHeapSize ?? null, ring: window.__g2wBench.ring, at: performance.now() })`,
      );
      const seconds = (end.at - start.at) / 1000;
      const fps = (end.frames - start.frames) / seconds;
      const ring = end.ring ?? [];
      const sorted = [...ring].sort((a, b) => a - b);
      const p95 =
        sorted.length > 0
          ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
          : null;
      const avgFrameMs = ring.length > 0 ? ring.reduce((a, b) => a + b, 0) / ring.length : null;
      const row = {
        sprites,
        fps: Number(fps.toFixed(1)),
        avgFrameMs: avgFrameMs === null ? null : Number(avgFrameMs.toFixed(2)),
        p95FrameMs: p95 === null ? null : Number(p95.toFixed(2)),
        heapMb:
          start.heap === null || end.heap === null ? null : Number((end.heap / 1048576).toFixed(1)),
        heapGrowthMb:
          start.heap === null || end.heap === null
            ? null
            : Number(((end.heap - start.heap) / 1048576).toFixed(1)),
        windowSeconds: Number(seconds.toFixed(1)),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }

    console.log("\n--- summary ---");
    console.log("sprites |    fps | avgFrameMs | p95FrameMs | heapMb | heapGrowthMb");
    for (const row of rows) {
      console.log(
        `${String(row.sprites).padStart(7)} | ${String(row.fps).padStart(6)} | ${String(row.avgFrameMs).padStart(10)} | ${String(row.p95FrameMs).padStart(10)} | ${String(row.heapMb).padStart(6)} | ${String(row.heapGrowthMb).padStart(12)}`,
      );
    }
    console.log(`\nEnvironment: headless ${await evaluate("navigator.userAgent")}`);
    console.log(
      `Sampling window: ${WINDOW_SECONDS}s per case; single run; re-run before comparing.`,
    );
    ws.close();
  } finally {
    chrome.kill();
    // Chrome's crashpad child can hold files briefly after kill on Windows;
    // a leftover temp profile is harmless, so cleanup must not throw.
    await sleep(1000);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // ignore — temp dir cleanup is best-effort
    }
  }
} finally {
  vite.kill();
}
