// R6-2 Part B: real-browser renderer-backend smoke test.
//
// Boots the hello-world demo under the Vite dev server, then drives one
// fresh headless-Chrome page per backend case (auto / webgl / canvas /
// webgpu) through the Chrome DevTools Protocol over a raw WebSocket
// (Node 22 built-in WebSocket, no packages added). Each case creates its own
// PixiRenderer on its own canvas, initializes it with the requested backend
// preference, renders a frame, records the ACTUAL backend from
// `renderer.capabilities.backend`, reads back a background pixel where the
// backend allows it, and disposes — then repeats-disposes to confirm the
// terminal contract. Fallback (requested != actual) is recorded, never
// treated as proof of the requested backend. A backend the browser cannot
// provide is reported as skipped with the reason, never faked.
//
// Usage:
//   node scripts/smoke-renderer-backends.mjs
// Environment:
//   G2W_CHROME   absolute path to a Chrome/Chromium binary
//                (default: C:/Program Files/Google/Chrome/Application/chrome.exe)
//   G2W_SMOKE_PORT  dev-server port (default 5199) and CDP port (+1)
//
// This is a hardware/browser-dependent smoke harness: it is NOT part of the
// default `pnpm test` suite and needs a locally installed Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.G2W_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEV_PORT = Number(process.env.G2W_SMOKE_PORT ?? 5199);
const CDP_PORT = DEV_PORT + 1;
const DEMO_URL = `http://localhost:${DEV_PORT}/`;
const BACKGROUND = [16, 153, 187]; // #1099bb, the probe's backgroundColor
const PIXEL_TOLERANCE = 3;

const CASES = ["auto", "webgl", "canvas", "webgpu"];

const results = [];
const record = (entry) => {
  results.push(entry);
  console.log(`\n[case] ${entry.case}`);
  console.log(JSON.stringify(entry, null, 2));
};

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
  { cwd: path.join(repoRoot, "examples/hello-world"), stdio: ["ignore", "inherit", "inherit"] },
);
try {
  await waitFor(
    async () => {
      try {
        const response = await fetch(DEMO_URL);
        return response.ok;
      } catch {
        return false;
      }
    },
    { attempts: 80, intervalMs: 250, description: "the Vite dev server" },
  );

  // --- Chrome ---------------------------------------------------------------
  const profileDir = mkdtempSync(path.join(tmpdir(), "g2w-r62-smoke-"));
  console.log(`starting headless Chrome (${CHROME})...`);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Give WebGPU a chance; if the environment still has no adapter the
      // webgpu case is reported as skipped with this exact reason.
      "--enable-unsafe-webgpu",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          return response.ok;
        } catch {
          return false;
        }
      },
      { attempts: 80, intervalMs: 250, description: "the Chrome DevTools endpoint" },
    );

    const versionInfo = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const browserWs = new WebSocket(versionInfo.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      browserWs.onopen = resolve;
      browserWs.onerror = reject;
    });

    let messageId = 0;
    const pending = new Map();
    const sessionListeners = new Map();
    browserWs.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      const listener = sessionListeners.get(message.sessionId);
      if (listener && message.method) listener(message);
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, { resolve, reject });
        browserWs.send(
          JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
        );
      });

    const userAgent = await (async () => {
      const created = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", {
        targetId: created.targetId,
        flatten: true,
      });
      const info = await send(
        "Runtime.evaluate",
        { expression: "navigator.userAgent", returnByValue: true },
        sessionId,
      );
      await send("Target.closeTarget", { targetId: created.targetId });
      return info.result.value;
    })();
    console.log(`browser: ${userAgent}`);

    for (const backendCase of CASES) {
      const pageErrors = [];
      const consoleErrors = [];
      const created = await send("Target.createTarget", { url: "about:blank" });
      const targetId = created.targetId;
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      sessionListeners.set(sessionId, (message) => {
        if (message.method === "Runtime.exceptionThrown") {
          pageErrors.push(
            message.params.exceptionDetails.exception?.description ??
              message.params.exceptionDetails.text,
          );
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
          consoleErrors.push(
            message.params.args.map((argument) => argument.value ?? argument.description).join(" "),
          );
        }
      });

      try {
        await send("Page.enable", {}, sessionId);
        await send("Runtime.enable", {}, sessionId);
        const loaded = send("Page.navigate", { url: DEMO_URL }, sessionId);
        const loadEvent = new Promise((resolve) => {
          const previous = sessionListeners.get(sessionId);
          sessionListeners.set(sessionId, (message) => {
            previous?.(message);
            if (message.method === "Page.loadEventFired") resolve();
          });
        });
        await Promise.race([
          Promise.all([loaded, loadEvent]),
          sleep(30000).then(() => {
            throw new Error("navigation timed out");
          }),
        ]);
        await sleep(1000); // let the demo's async bootstrap finish before probing

        const probe = `(() => {
  const CASE = ${JSON.stringify(backendCase)};
  const BACKGROUND = ${JSON.stringify(BACKGROUND)};
  const TOLERANCE = ${PIXEL_TOLERANCE};
  return (async () => {
    const requested = CASE === "auto" ? undefined : CASE;
    let webgpuAdapterAvailable = null;
    if (CASE === "webgpu") {
      try {
        webgpuAdapterAvailable = Boolean(
          navigator.gpu && (await navigator.gpu.requestAdapter()),
        );
      } catch {
        webgpuAdapterAvailable = false;
      }
      if (!webgpuAdapterAvailable) {
        return {
          requested: CASE,
          skipped: "WebGPU is unavailable in this Chrome environment (navigator.gpu or adapter missing)",
        };
      }
    }
    const { PixiRenderer } = await import("/@id/@g2w/renderer-pixi");
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const renderer = new PixiRenderer();
    const out = {
      requested: CASE,
      initOk: false,
      initError: null,
      actualBackend: null,
      frameRendered: false,
      pixel: null,
      pixelNote: null,
      disposeOk: false,
      disposeError: null,
      repeatedDisposeRejected: false,
    };
    try {
      await renderer.initialize({
        canvas,
        width: 320,
        height: 180,
        backgroundColor: "#1099bb",
        ...(requested === undefined ? {} : { backend: requested }),
      });
      out.initOk = true;
      out.actualBackend = renderer.capabilities.backend;
      renderer.render();
      out.frameRendered = true;
      if (out.actualBackend === "canvas") {
        const context2d = canvas.getContext("2d");
        if (context2d) {
          const data = context2d.getImageData(160, 90, 1, 1).data;
          out.pixel = [data[0], data[1], data[2], data[3]];
        } else {
          out.pixelNote = "2d context unavailable for readback";
        }
      } else if (out.actualBackend === "webgl") {
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        if (gl) {
          const pixel = new Uint8Array(4);
          gl.readPixels(
            Math.floor(gl.drawingBufferWidth / 2),
            Math.floor(gl.drawingBufferHeight / 2),
            1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
          );
          out.pixel = [pixel[0], pixel[1], pixel[2], pixel[3]];
        } else {
          out.pixelNote = "webgl context unavailable for readback";
        }
      } else {
        // WebGPU canvases cannot be read back through a GPU readPixels call
        // without an extra copy pipeline; try the cheap 2D drawImage
        // readback instead and record the result either way.
        try {
          const probe = document.createElement("canvas");
          probe.width = canvas.width;
          probe.height = canvas.height;
          const context2d = probe.getContext("2d");
          context2d.drawImage(canvas, 0, 0);
          const data = context2d.getImageData(
            Math.floor(probe.width / 2),
            Math.floor(probe.height / 2),
            1, 1,
          ).data;
          out.pixel = [data[0], data[1], data[2], data[3]];
        } catch (readbackError) {
          out.pixel = null;
          out.pixelNote =
            "WebGPU canvas readback failed: " + String(readbackError?.message ?? readbackError);
        }
      }
      await renderer.dispose();
      out.disposeOk = true;
      try {
        await renderer.dispose();
      } catch {
        out.repeatedDisposeRejected = true;
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!out.initOk) out.initError = message;
      else out.disposeError = message;
    }
    return out;
  })();
})()`;

        const evaluation = await send(
          "Runtime.evaluate",
          { expression: probe, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (evaluation.exceptionDetails) {
          record({
            case: backendCase,
            status: "failed",
            error:
              evaluation.exceptionDetails.exception?.description ??
              evaluation.exceptionDetails.text,
            pageErrors,
            consoleErrors,
          });
        } else {
          const out = evaluation.result.value;
          let status;
          if (out.skipped) {
            status = "skipped";
          } else if (!out.initOk) {
            status = "failed";
          } else if (out.disposeError !== null) {
            status = "failed";
          } else if (requestedMatchesActual(out)) {
            status = pixelMatches(out) ? "verified" : "failed (pixel mismatch)";
          } else {
            status = "fallback (requested backend NOT verified)";
          }
          record({ case: backendCase, status, ...out, pageErrors, consoleErrors });
        }
      } finally {
        sessionListeners.delete(sessionId);
        await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    }

    browserWs.close();
  } finally {
    chrome.kill();
    // Chrome keeps crashpad files locked for a moment after kill on Windows;
    // the profile lives in the OS temp dir anyway, so cleanup is best-effort.
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Left for the OS to clean up.
    }
  }
} finally {
  vite.kill();
}

function requestedMatchesActual(out) {
  if (out.requested === "auto") {
    return typeof out.actualBackend === "string" && out.actualBackend.length > 0;
  }
  return out.actualBackend === out.requested;
}

function pixelMatches(out) {
  if (out.pixel === null) {
    // Readback not possible for this backend; frame evidence is render()
    // completing without error. Recorded via pixelNote, not hidden.
    return true;
  }
  const [r, g, b, a] = out.pixel;
  const [er, eg, eb] = BACKGROUND;
  const rgbMatches =
    Math.abs(r - er) <= PIXEL_TOLERANCE &&
    Math.abs(g - eg) <= PIXEL_TOLERANCE &&
    Math.abs(b - eb) <= PIXEL_TOLERANCE;
  return rgbMatches && (a === undefined || a === 255);
}

// --- Summary ----------------------------------------------------------------
console.log("\n== R6-2 backend smoke summary ==");
for (const entry of results) {
  const detail = entry.skipped ? ` (${entry.skipped})` : ` actual=${entry.actualBackend}`;
  console.log(`${entry.status.padEnd(40)} ${entry.case}${detail}`);
}
const hardFailures = results.filter(
  (entry) => entry.status.startsWith("failed") && (entry.case === "auto" || entry.case === "webgl"),
);
process.exit(hardFailures.length > 0 ? 1 : 0);
