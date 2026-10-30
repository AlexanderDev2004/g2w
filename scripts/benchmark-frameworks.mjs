// R13 acceptance criterion 4: cross-framework runtime benchmark.
//
// Runs the SAME sprite workload (scripts/bench-pages/bench-common.js — one
// shared implementation of the orbit math and frame counters) on g2w and on
// three competitor stacks, in the same headless Chrome on the same machine:
//   g2w    — examples/hello-world/bench.html via the Vite dev server
//   pixi   — raw PixiJS 8.22.0 (the renderer g2w adapts): the adapter baseline
//   phaser — Phaser 4.2.1's sprite API and scene loop
//   three  — Three.js 0.186.1 Sprites (per-sprite materials)
// The competitor pages load their framework from esm.sh with pinned versions,
// so this script adds no dependency to the repository.
//
// Per target × case: navigate, wait for ready, settle, sample a fixed window;
// each case runs G2W_BENCH_RUNS times and the summary reports per-metric
// medians — the same methodology as scripts/benchmark-runtime.mjs.
//
// Usage:
//   node scripts/benchmark-frameworks.mjs
// Environment: same knobs as benchmark-runtime.mjs (G2W_CHROME, G2W_BENCH_PORT,
//   G2W_BENCH_SECONDS, G2W_BENCH_RUNS, G2W_BENCH_CASES).
//
// Browser- and network-dependent (CDN fetches on first load): NOT part of
// `pnpm test`, not run in CI. Machine-specific — re-run before comparing.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path, { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.G2W_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEV_PORT = Number(process.env.G2W_BENCH_PORT ?? 5201);
const CDP_PORT = DEV_PORT + 1;
const PAGES_PORT = DEV_PORT + 2;
const WINDOW_SECONDS = Number(process.env.G2W_BENCH_SECONDS ?? 10);
const RUNS = Math.max(1, Number.parseInt(process.env.G2W_BENCH_RUNS ?? "3", 10));
const CASES = (process.env.G2W_BENCH_CASES ?? "100,1000,5000,20000,50000")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

const TARGETS = [
  { id: "g2w", url: (sprites) => `http://localhost:${DEV_PORT}/bench.html?sprites=${sprites}` },
  { id: "pixi", url: (sprites) => `http://localhost:${PAGES_PORT}/pixi.html?sprites=${sprites}` },
  {
    id: "phaser",
    url: (sprites) => `http://localhost:${PAGES_PORT}/phaser.html?sprites=${sprites}`,
  },
  { id: "three", url: (sprites) => `http://localhost:${PAGES_PORT}/three.html?sprites=${sprites}` },
].filter((target) =>
  (process.env.G2W_BENCH_TARGETS ?? "g2w,pixi,phaser,three").split(",").includes(target.id),
);

const MIME = { ".html": "text/html", ".js": "text/javascript" };
const pagesRoot = join(repoRoot, "scripts/bench-pages");
const staticServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = join(pagesRoot, url.pathname.replace(/^\/+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { attempts, intervalMs, description }) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

console.log(`starting Vite dev server on port ${DEV_PORT} and bench pages on ${PAGES_PORT}...`);
await new Promise((resolve) => staticServer.listen(PAGES_PORT, resolve));
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

  const profile = mkdtempSync(path.join(tmpdir(), "g2w-fwbench-"));
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
    const readyCheck = `(() => { const b = document.querySelector('#bench-error'); if (b && !b.hidden) throw new Error(b.textContent); return (window.__fwBench ?? window.__g2wBench)?.ready === true; })()`;
    const snapshot = (withRing) =>
      `(() => { const c = window.__fwBench ?? window.__g2wBench; return { frames: c.frames, heap: performance.memory?.usedJSHeapSize ?? null, at: performance.now()${withRing ? ", ring: c.ring" : ""} }; })()`;

    const results = new Map();
    for (const target of TARGETS) {
      for (const sprites of CASES) {
        const runs = [];
        for (let run = 0; run < RUNS; run++) {
          process.stdout.write(
            `[case] ${target.id} sprites=${sprites} run ${run + 1}/${RUNS} ... `,
          );
          // about:blank between runs: a heavy page (50k sprites) shares the
          // renderer process with the next page (same-site ports) and can
          // starve its load if torn down mid-navigation.
          await send("Page.navigate", { url: "about:blank" });
          await sleep(700);
          await send("Page.navigate", { url: target.url(sprites) });
          try {
            await waitFor(() => evaluate(readyCheck), {
              attempts: 240,
              intervalMs: 250,
              description: `the ${target.id} bench scene (${sprites} sprites)`,
            });
          } catch (error) {
            // Dump page state so a CDN/setup failure names itself.
            const state = await evaluate(
              `JSON.stringify({ url: location.href, err: document.querySelector('#bench-error')?.textContent?.slice(0, 300), errHidden: document.querySelector('#bench-error')?.hidden, ready: (window.__fwBench ?? window.__g2wBench)?.ready })`,
            );
            throw new Error(`${error.message} — page state: ${state}`);
          }
          await sleep(2000);
          const start = await evaluate(snapshot(false));
          await sleep(WINDOW_SECONDS * 1000);
          const end = await evaluate(snapshot(true));
          const seconds = (end.at - start.at) / 1000;
          const fps = (end.frames - start.frames) / seconds;
          const ring = end.ring ?? [];
          const sorted = [...ring].sort((a, b) => a - b);
          const p95 =
            sorted.length > 0
              ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
              : null;
          const avgFrameMs = ring.length > 0 ? ring.reduce((a, b) => a + b, 0) / ring.length : null;
          const run_ = {
            fps: Number(fps.toFixed(1)),
            avgFrameMs: avgFrameMs === null ? null : Number(avgFrameMs.toFixed(2)),
            p95FrameMs: p95 === null ? null : Number(p95.toFixed(2)),
            heapMb:
              start.heap === null || end.heap === null
                ? null
                : Number((end.heap / 1048576).toFixed(1)),
          };
          runs.push(run_);
          console.log(JSON.stringify(run_));
        }
        const median = (values) => {
          const sortedValues = [...values].filter((v) => v !== null).sort((a, b) => a - b);
          if (sortedValues.length === 0) return null;
          const mid = Math.floor(sortedValues.length / 2);
          const value =
            sortedValues.length % 2 === 0
              ? (sortedValues[mid - 1] + sortedValues[mid]) / 2
              : sortedValues[mid];
          return Number(value.toFixed(2));
        };
        const row = {
          sprites,
          fps: median(runs.map((r) => r.fps)),
          avgFrameMs: median(runs.map((r) => r.avgFrameMs)),
          p95FrameMs: median(runs.map((r) => r.p95FrameMs)),
          heapMb: median(runs.map((r) => r.heapMb)),
        };
        const table = results.get(target.id) ?? [];
        table.push(row);
        results.set(target.id, table);
      }
    }

    console.log(`\n--- summary (median of ${RUNS} runs) ---`);
    for (const [targetId, table] of results) {
      console.log(`\n${targetId}:`);
      console.log("sprites |    fps | avgFrameMs | p95FrameMs | heapMb");
      for (const row of table) {
        console.log(
          `${String(row.sprites).padStart(7)} | ${String(row.fps).padStart(6)} | ${String(row.avgFrameMs).padStart(10)} | ${String(row.p95FrameMs).padStart(10)} | ${String(row.heapMb).padStart(6)}`,
        );
      }
    }
    console.log(`\nEnvironment: headless ${await evaluate("navigator.userAgent")}`);
    console.log(
      `Sampling window: ${WINDOW_SECONDS}s per run, ${RUNS} run(s) per case, median reported. Machine-specific: re-run before comparing.`,
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
  staticServer.close();
}
