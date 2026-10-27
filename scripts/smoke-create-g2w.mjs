#!/usr/bin/env node
/**
 * Smoke-test for create-g2w: local-package validation.
 *
 * 1. Packs the @g2w/* workspace packages into tarballs (requires pnpm build).
 * 2. Runs the create-g2w CLI into a temporary directory OUTSIDE the workspace.
 * 3. Rewrites the generated project's @g2w deps to file: tarball URLs.
 * 4. Installs, typechecks, unit-tests, and builds the generated project.
 * 5. Boots `pnpm dev` and verifies the page in a real headless Chrome via CDP
 *    (canvas present, game loop started, no console/exception errors).
 *
 * This is LOCAL-PACKAGE validation, not published-package validation: the
 * @g2w/* packages are not on npm yet (ROADMAP R10).
 *
 * Usage:  pnpm build && node scripts/smoke-create-g2w.mjs
 * Env:    CHROME_PATH (optional) — path to a Chrome executable.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_PORT = 5577;
const CDP_PORT = SMOKE_PORT + 1;
const PACKAGES = ["core", "runtime", "renderer-pixi", "input-dom"];

const fail = (message) => {
  console.error(`smoke-create-g2w: FAIL — ${message}`);
  process.exitCode = 1;
};

// Hard stop: the smoke must never hang indefinitely (a dead browser, a stuck
// CDP socket, a wedged server). Ten minutes is far above the sum of the
// bounded steps; reaching it is always a bug in the environment, not progress.
setTimeout(
  () => {
    console.error("smoke-create-g2w: FAIL — global watchdog (10 min) force-exited the run");
    process.exit(1);
  },
  10 * 60 * 1000,
);

function runStep(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => {
    try {
      return (
        spawnSync("node", ["-e", `require('fs').accessSync(${JSON.stringify(candidate)})`], {
          stdio: "ignore",
        }).status === 0
      );
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Pack @g2w/* tarballs.
// ---------------------------------------------------------------------------
/** Fast recursive delete: native rmdir on Windows, rmSync elsewhere. */
function removeDirFast(dir) {
  if (process.platform === "win32") {
    spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", dir], { stdio: "ignore" });
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

const packDir = mkdtempSync(path.join(tmpdir(), "g2w-smoke-pack-"));
const tarballs = {};
let projectsRoot = null;
let chromeProfileDir = null;
try {
  console.log("== packing @g2w/* packages (local-package validation, not published packages) ==");
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(repoRoot, "packages", pkg);
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const result = runStep("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: pkgDir,
      capture: true,
    });
    // pnpm pack prints the full tarball path on its last output line.
    const tarballPath = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    tarballs[manifest.name] = path.join(packDir, path.basename(tarballPath));
    console.log(`   ${manifest.name} -> ${path.basename(tarballPath)}`);
  }

  // ---------------------------------------------------------------------------
  // 2. Generate a project OUTSIDE the workspace.
  // ---------------------------------------------------------------------------
  projectsRoot = mkdtempSync(path.join(tmpdir(), "g2w-smoke-projects-"));
  const projectDir = path.join(projectsRoot, "smoke-game");
  console.log(`\n== generating project in ${projectDir} ==`);
  runStep(process.execPath, [
    path.join(repoRoot, "packages/create-g2w/dist/cli.js"),
    projectDir,
    "--name",
    "smoke-game",
  ]);

  // ---------------------------------------------------------------------------
  // 3. Point @g2w deps at the packed tarballs (relative paths — pnpm on
  //    Windows mis-resolves absolute file: URLs; keeping the tarballs inside
  //    the generated project makes the resolution self-contained).
  // ---------------------------------------------------------------------------
  const tarballDirName = ".g2w-tarballs";
  const projectTarballDir = path.join(projectDir, tarballDirName);
  mkdirSync(projectTarballDir, { recursive: true });
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [name, tarball] of Object.entries(tarballs)) {
    if (manifest.dependencies[name] !== undefined) {
      const copy = path.join(projectTarballDir, path.basename(tarball));
      copyFileSync(tarball, copy);
      manifest.dependencies[name] = `file:${tarballDirName}/${path.basename(tarball)}`;
    }
  }
  // Packed tarballs declare their own @g2w/* deps as registry versions
  // (workspace:* was rewritten to 0.1.0 at pack time), so also pin them via
  // pnpm overrides or the install would hit the npm registry for them.
  // pnpm >= 12 reads settings from pnpm-workspace.yaml, not package.json.
  writeFileSync(
    path.join(projectDir, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(tarballs)
      .filter(([name]) => manifest.dependencies[name] !== undefined)
      .map(([name, tarball]) => `  "${name}": "file:${tarballDirName}/${path.basename(tarball)}"`)
      .join("\n")}\n`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("   @g2w/* deps rewritten to packed tarballs (+ pnpm overrides)");

  // ---------------------------------------------------------------------------
  // 4. Install, typecheck, test, build.
  // ---------------------------------------------------------------------------
  console.log("\n== pnpm install (fresh, outside the workspace) ==");
  runStep("pnpm", ["install"], { cwd: projectDir });
  console.log("\n== pnpm typecheck ==");
  runStep("pnpm", ["run", "typecheck"], { cwd: projectDir });
  console.log("\n== pnpm test ==");
  runStep("pnpm", ["test"], { cwd: projectDir });
  console.log("\n== pnpm build ==");
  runStep("pnpm", ["run", "build"], { cwd: projectDir });

  // ---------------------------------------------------------------------------
  // 5. Browser smoke: dev server + headless Chrome via CDP.
  // ---------------------------------------------------------------------------
  const chromePath = findChrome();
  if (chromePath === undefined) {
    console.log("\n== browser smoke SKIPPED (no Chrome found; set CHROME_PATH to enable) ==");
  } else {
    console.log(`\n== browser smoke (dev server :${SMOKE_PORT}, ${chromePath}) ==`);
    const vite = spawn(
      process.execPath,
      [
        path.join(projectDir, "node_modules/vite/bin/vite.js"),
        "--port",
        String(SMOKE_PORT),
        "--strictPort",
      ],
      { cwd: projectDir, stdio: "ignore" },
    );
    let chrome = null;
    try {
      await withTimeout(
        (async () => {
          for (;;) {
            try {
              // Vite binds to `localhost` (which may be ::1), so fetch the
              // same host — 127.0.0.1 can miss an IPv6-only listener.
              const response = await fetch(`http://localhost:${SMOKE_PORT}/`);
              if (response.ok) return;
            } catch {
              // Server not up yet.
            }
            await sleep(200);
          }
        })(),
        30000,
        "vite dev server startup",
      );

      chromeProfileDir = mkdtempSync(path.join(tmpdir(), "g2w-smoke-chrome-"));
      chrome = spawn(
        chromePath,
        [
          "--headless=new",
          `--remote-debugging-port=${CDP_PORT}`,
          `--user-data-dir=${chromeProfileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          `http://localhost:${SMOKE_PORT}/`,
        ],
        { stdio: "ignore" },
      );

      // Connect directly to the page target's own WebSocket (the browser-level
      // endpoint rejects page-domain commands).
      let page = null;
      await withTimeout(
        (async () => {
          for (;;) {
            try {
              const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
              page = targets.find(
                (t) => t.type === "page" && t.url.startsWith(`http://localhost:${SMOKE_PORT}`),
              );
              if (page !== undefined) return;
            } catch {
              // Chrome has not opened its CDP port yet.
            }
            await sleep(200);
          }
        })(),
        30000,
        "Chrome page target",
      );

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await withTimeout(
        new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error("page WebSocket failed to open"));
        }),
        15000,
        "CDP WebSocket open",
      );

      let nextId = 0;
      const pending = new Map();
      const consoleErrors = [];
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
          return;
        }
        if (message.method === "Runtime.exceptionThrown") {
          consoleErrors.push(message.params?.exceptionDetails?.text ?? "exception");
        }
        if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
          consoleErrors.push(
            message.params.args?.map((a) => a.value ?? a.description ?? "").join(" "),
          );
        }
      };
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, (response) => {
            if (response.error !== undefined) {
              reject(new Error(`${method}: ${response.error.message}`));
            } else {
              resolve(response);
            }
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      // A dead browser never answers: reject every pending command when the
      // socket closes, and bound every command with a timeout.
      ws.onclose = () => {
        for (const settle of pending.values()) {
          settle({ error: { message: "CDP socket closed before the command answered" } });
        }
        pending.clear();
      };
      const sendBounded = (method, params = {}) =>
        withTimeout(send(method, params), 15000, `CDP ${method}`);

      await sendBounded("Runtime.enable");
      await sleep(2500); // let the demo boot and run a few frames

      const check = await sendBounded("Runtime.evaluate", {
        expression:
          "JSON.stringify({ started: window.__G2W_STARTED === true, canvas: document.querySelector('canvas#game') !== null })",
        returnByValue: true,
      });
      const state = JSON.parse(check.result.result.value);
      console.log(`   page state: ${JSON.stringify(state)}`);

      const problems = [];
      if (!state.canvas) problems.push("the game canvas is missing");
      if (!state.started) problems.push("__G2W_STARTED was never set (the loop did not start)");
      if (consoleErrors.length > 0)
        problems.push(`console/page errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`);
      if (problems.length > 0) {
        throw new Error(problems.join("; "));
      }
      console.log("   canvas present, loop running, zero console/page errors");
      ws.close();
    } finally {
      if (chrome !== null) chrome.kill();
      vite.kill();
      // Vite children can outlive the direct child on Windows; kill the tree.
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
        if (chrome !== null) {
          spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
        }
      }
    }
  }

  console.log("\n== smoke-create-g2w: all steps passed ==");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  removeDirFast(packDir);
  if (chromeProfileDir !== null) {
    removeDirFast(chromeProfileDir);
  }
  // The temp project tree is removed only when every step passed, so a
  // failure leaves the generated project on disk for inspection.
  if (process.exitCode !== 1 && projectsRoot !== null) {
    removeDirFast(projectsRoot);
  }
}

// Forced exit: killed children and pooled sockets must never keep the run
// alive past its report — the exit code is already decided above.
process.exit(process.exitCode ?? 0);
