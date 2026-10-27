#!/usr/bin/env node
/**
 * R10 Phase 1 — packability and consumer validation (no publishing).
 *
 * Proves every intended npm package can be packed and consumed OUTSIDE the
 * pnpm monorepo before any public release:
 *
 * 1. Builds all packages (`pnpm build`).
 * 2. Packs the eight intended publishable packages into a temp directory
 *    OUTSIDE the workspace (`pnpm pack`).
 * 3. Validates each tarball: manifest invariants (`main`/`types`/`exports`/
 *    `bin`/`files` point at archived files), no unresolved `workspace:*`
 *    dependencies, no dev-only files or secrets in the archive, dependency
 *    versions consistent across the packed set.
 * 4. Installs the tarballs into a throwaway TypeScript + Vite consumer
 *    project OUTSIDE the workspace, then typechecks and builds against the
 *    public entry points (proving type declarations and runtime resolution).
 * 5. Runs the packed `create-g2w` CLI from the consumer's node_modules to
 *    scaffold a project (the browser runtime smoke stays in
 *    scripts/smoke-create-g2w.mjs — this script is static/build validation).
 *
 * This is LOCAL validation only: nothing is published, no tag is created.
 * Deliberately NOT part of ordinary CI: it performs fresh npm installs of
 * Vite/TypeScript and is therefore slower and network-dependent than the
 * fast validate job (same reasoning as the scaffold smoke).
 *
 * Usage:  node scripts/validate-packages.mjs   (runs `pnpm build` first)
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The intended publishable inventory (verified against packages/*, not assumed). */
const PACKAGES = [
  "core",
  "runtime",
  "renderer-pixi",
  "input-dom",
  "input-gamepad",
  "audio-web",
  "devtools",
  "create-g2w",
];

const fail = (message) => {
  console.error(`validate-packages: FAIL — ${message}`);
  process.exitCode = 1;
};

let packDir = null;
let consumerDir = null;
try {
  // ---------------------------------------------------------------------------
  // 1. Build everything first: packed dist/ must be current.
  // ---------------------------------------------------------------------------
  console.log("== pnpm build ==");
  runStep("pnpm", ["build"]);

  // ---------------------------------------------------------------------------
  // 2. Pack all intended packages into a temp dir outside the workspace.
  // ---------------------------------------------------------------------------
  packDir = mkdtempSync(path.join(tmpdir(), "g2w-pack-validate-"));
  console.log(`\n== packing ${PACKAGES.length} packages into ${packDir} ==`);
  const tarballs = new Map(); // package name -> { version, tarball, cwd }
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(repoRoot, "packages", pkg);
    const result = runStep("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: pkgDir,
      capture: true,
    });
    const tarballPath = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    tarballs.set(manifest.name, {
      version: manifest.version,
      tarball: path.join(packDir, path.basename(tarballPath)),
      cwd: pkgDir,
    });
    console.log(`   ${manifest.name}@${manifest.version} -> ${path.basename(tarballPath)}`);
  }

  // ---------------------------------------------------------------------------
  // 3. Validate each tarball.
  // ---------------------------------------------------------------------------
  console.log("\n== validating tarball manifests and archive contents ==");
  for (const [name, packed] of tarballs) {
    const violations = validateTarball(packed, tarballs);
    if (violations.length > 0) {
      fail(`${name}:\n     - ${violations.join("\n     - ")}`);
    } else {
      console.log(`   ${name}: manifest, exports, and archive contents OK`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Real external consumption: TS + Vite consumer from the tarballs.
  // ---------------------------------------------------------------------------
  consumerDir = mkdtempSync(path.join(tmpdir(), "g2w-pack-consumer-"));
  buildConsumerProject(consumerDir, tarballs);
  console.log("\n== consumer: pnpm install (tarball deps, outside the workspace) ==");
  runStep("pnpm", ["install"], { cwd: consumerDir });
  console.log("== consumer: tsc --noEmit (type declarations resolve) ==");
  runStep("pnpm", ["run", "typecheck"], { cwd: consumerDir });
  console.log("== consumer: vite build (imports build against the archives) ==");
  runStep("pnpm", ["run", "build"], { cwd: consumerDir });

  // ---------------------------------------------------------------------------
  // 5. The packed create-g2w CLI works from the consumer's node_modules.
  //    (Browser runtime smoke for the generated project: smoke-create-g2w.)
  // ---------------------------------------------------------------------------
  console.log("\n== consumer: run the packed create-g2w CLI ==");
  const scaffoldDir = path.join(consumerDir, "scaffolded");
  runStep(
    process.execPath,
    [
      path.join(consumerDir, "node_modules/create-g2w/dist/cli.js"),
      scaffoldDir,
      "--name",
      "cli-generated",
    ],
    { cwd: consumerDir },
  );
  for (const expected of ["package.json", "index.html", "src/main.ts", ".gitignore"]) {
    if (!existsSync(path.join(scaffoldDir, expected))) {
      fail(`create-g2w (packed): scaffolded project is missing ${expected}`);
    }
  }
  if (process.exitCode !== 1) console.log("   scaffolded project generated from the packed CLI");

  if (process.exitCode !== 1) {
    console.log("\n== validate-packages: all invariants held (nothing was published) ==");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  // Temporary artifacts are removed reliably, including on failure.
  if (packDir !== null) removeDirFast(packDir);
  if (consumerDir !== null) removeDirFast(consumerDir);
}

// -----------------------------------------------------------------------------

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

/** Fast recursive delete: native rmdir on Windows, rmSync elsewhere. */
function removeDirFast(dir) {
  if (process.platform === "win32") {
    spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", dir], { stdio: "ignore" });
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Recursively lists relative file paths inside an extracted package root. */
function listFiles(base, prefix = "") {
  const files = [];
  for (const entry of readdirSync(path.join(base, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(base, relative));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

/**
 * Extracts the tarball next to itself (a sibling temp dir, outside the
 * workspace) and runs every manifest/archive invariant. Returns violations.
 */
function validateTarball(packed, tarballs) {
  const violations = [];
  const extractDir = mkdtempSync(path.join(tmpdir(), "g2w-pack-extract-"));
  try {
    runStep("tar", ["-xzf", packed.tarball, "-C", extractDir]);
    const root = path.join(extractDir, "package");
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const files = listFiles(root);

    // The tarball must carry the exact built version, never a placeholder.
    if (manifest.version !== packed.version) {
      violations.push(`manifest version ${manifest.version} != package version ${packed.version}`);
    }

    // Release metadata invariants (R10 Phase 2): the packed manifest must be
    // fully attributable and runnable on the supported Node line.
    if (typeof manifest.description !== "string" || manifest.description.length === 0) {
      violations.push("packed manifest has no description");
    }
    if (manifest.license !== "MIT") {
      violations.push(`packed license is ${JSON.stringify(manifest.license)}, expected "MIT"`);
    }
    const repositoryUrl =
      typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    if (repositoryUrl === undefined || !repositoryUrl.includes("github.com/AlexanderDev2004/g2w")) {
      violations.push("packed repository field must point at github.com/AlexanderDev2004/g2w");
    }
    if (manifest.engines?.node !== ">=22") {
      violations.push(
        `packed engines.node is ${JSON.stringify(manifest.engines?.node)}, expected ">=22"`,
      );
    }

    // No unresolved workspace protocol may survive packing (pnpm rewrites
    // workspace:* at pack time — asserted, not assumed).
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (typeof range === "string" && range.includes("workspace:")) {
          violations.push(`${field}.${dep} still declares ${range}`);
        }
      }
    }

    // Every referenced entry point must exist inside the archive.
    const referenced = [];
    for (const field of ["main", "module", "types", "typings"]) {
      if (typeof manifest[field] === "string") referenced.push(manifest[field]);
    }
    if (manifest.exports !== undefined) {
      for (const value of flattenExports(manifest.exports)) {
        if (typeof value === "string") referenced.push(value);
      }
    }
    if (manifest.bin !== undefined) {
      for (const value of Object.values(manifest.bin)) {
        if (typeof value === "string") referenced.push(value);
      }
    }
    for (const reference of referenced) {
      const relative = reference.replace(/^\.\//, "");
      if (!files.includes(relative)) {
        violations.push(`entry point ${reference} is missing from the archive`);
      }
    }

    // Every `files` entry must exist, and nothing outside the allowlist may
    // ship: sources, configs, tests, env files, secrets, workspace junk.
    for (const included of manifest.files ?? []) {
      if (!files.some((file) => file === included || file.startsWith(`${included}/`))) {
        violations.push(`files entry "${included}" is missing from the archive`);
      }
    }
    const allowed = new Set(["package.json", "README.md", "LICENSE"]);
    for (const declared of manifest.files ?? []) {
      allowed.add(declared);
    }
    for (const file of files) {
      const top = file.split("/")[0];
      if (!allowed.has(top)) {
        violations.push(`archive contains undeclared file "${file}"`);
      }
    }
    for (const file of files) {
      if (
        file.endsWith(".tsbuildinfo") ||
        /(^|\/)\.env/.test(file) ||
        /\.(pem|key|p12)$/.test(file) ||
        /(^|\/)(id_rsa|id_ed25519|\.npmrc)$/.test(file)
      ) {
        violations.push(`archive contains a forbidden artifact "${file}"`);
      }
    }

    // Dependency relationships: every @g2w/* dep must resolve to a packed
    // tarball of a compatible version.
    for (const field of ["dependencies", "peerDependencies"]) {
      const deps = manifest[field];
      if (deps === undefined) continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (!dep.startsWith("@g2w/")) continue;
        const packedDep = tarballs.get(dep);
        if (packedDep === undefined) {
          violations.push(`${field}.${dep}: dependency is not part of the packed inventory`);
          continue;
        }
        if (!versionSatisfies(packedDep.version, range)) {
          violations.push(
            `${field}.${dep}: packed ${packedDep.version} does not satisfy declared ${range}`,
          );
        }
      }
    }

    // The CLI package must ship its template directory, including the
    // dotless `gitignore` (npm/pnpm pack exclude `.gitignore` from archives).
    if (manifest.name === "create-g2w") {
      if (!files.includes("template/package.json")) {
        violations.push("create-g2w archive is missing template/package.json");
      }
      if (!files.includes("template/gitignore")) {
        violations.push(
          "create-g2w archive is missing template/gitignore (scaffolded projects would lose their .gitignore)",
        );
      }
      if (manifest.bin === undefined || manifest.bin["create-g2w"] === undefined) {
        violations.push("create-g2w archive declares no create-g2w bin");
      }
    }
  } finally {
    removeDirFast(extractDir);
  }
  return violations;
}

function flattenExports(exports_) {
  const values = [];
  for (const value of Object.values(exports_)) {
    if (typeof value === "string") {
      values.push(value);
    } else if (value !== null && typeof value === "object") {
      values.push(...flattenExports(value));
    }
  }
  return values;
}

/**
 * Minimal range check for the shapes this repo declares (exact versions,
 * `^`/`~` ranges, and `>=` floors). Avoids pulling in a semver dependency.
 */
function versionSatisfies(version, range) {
  const parts = (candidate) => candidate.split(".").map(Number);
  const compare = (a, b) => {
    const [pa, pb] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  if (range === version) return true;
  const base = range.replace(/^[^0-9]*/, "");
  if (range.startsWith(">=")) return compare(version, base) >= 0;
  if (range.startsWith("^")) {
    return compare(version, base) >= 0 && version.split(".")[0] === base.split(".")[0];
  }
  if (range.startsWith("~")) {
    return (
      compare(version, base) >= 0 &&
      version.split(".").slice(0, 2).join(".") === base.split(".").slice(0, 2).join(".")
    );
  }
  return false;
}

/**
 * Builds a throwaway consumer project whose only g2w source is the packed
 * tarballs: relative `file:` deps (pnpm on Windows mis-resolves absolute
 * file: URLs) plus pnpm-workspace overrides for the transitive @g2w/*
 * registry versions inside the packed manifests (workspace:* was rewritten
 * to real versions at pack time; until publishing exists, overrides are the
 * honest local stand-in for the registry).
 */
function buildConsumerProject(consumerDir, tarballs) {
  const tarballDirName = ".g2w-tarballs";
  const consumerTarballDir = path.join(consumerDir, tarballDirName);
  mkdirSync(consumerTarballDir, { recursive: true });
  const dependencies = {};
  const overrides = {};
  for (const [name, packed] of tarballs) {
    const copy = path.join(consumerTarballDir, path.basename(packed.tarball));
    copyFileSync(packed.tarball, copy);
    const spec = `file:${tarballDirName}/${path.basename(packed.tarball)}`;
    dependencies[name] = spec;
    overrides[name] = spec;
  }

  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "g2w-pack-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
          build: "vite build",
        },
        dependencies,
        devDependencies: {
          typescript: "^5.9.3",
          vite: "^8.3.5",
        },
        engines: { node: ">=22" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(consumerDir, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(overrides)
      .map(([name, spec]) => `  "${name}": "${spec}"`)
      .join("\n")}\n`,
  );
  writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(consumerDir, "index.html"),
    '<!doctype html><html><body><canvas id="game"></canvas><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  mkdirSync(path.join(consumerDir, "src"), { recursive: true });
  writeFileSync(
    path.join(consumerDir, "src/main.ts"),
    `// Consumer proof: every public entry point imports, typechecks, and builds
// purely from the packed tarballs. Runtime wiring mirrors the hello-world
// demo; nothing here runs in this validation (no browser involved).
import { AudioManager, type Scene, GamepadState, InputState, SceneManager } from "@g2w/core";
import { WebAudioBackend } from "@g2w/audio-web";
import { DomInput } from "@g2w/input-dom";
import { GamepadInput } from "@g2w/input-gamepad";
import { PixiRenderer, createTextureAssetManager } from "@g2w/renderer-pixi";
import { G2WGame } from "@g2w/runtime";
import type { DevTools } from "@g2w/devtools";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (canvas === null) throw new Error("missing canvas");

const renderer = new PixiRenderer();
const input = new InputState();
const gamepadState = new GamepadState();
const assets = createTextureAssetManager();
const audio = new AudioManager({ backend: new WebAudioBackend({ context: new AudioContext() }) });
let devtools: DevTools | undefined;

// A minimal registered scene keeps the SceneManager constructor contract
// (a registered initial scene) satisfied without any game logic.
const boot: Scene = {
  init() {},
  enter() {},
  update() {},
  exit() {},
  dispose() {},
};
const scenes = new SceneManager({ scenes: { boot }, initial: "boot" });
const game = new G2WGame({ renderer, canvas, width: 640, height: 360 });
const domInput = new DomInput(input, { canvas });
const gamepadInput = new GamepadInput(gamepadState);

// Referenced so every import stays honest under strict checks.
export const runtime = {
  renderer,
  input,
  gamepadState,
  assets,
  audio,
  scenes,
  game,
  domInput,
  gamepadInput,
  devtools,
};
`,
  );
}
