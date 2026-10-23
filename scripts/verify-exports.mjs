import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Verifies that the built packages are loadable through their real package
 * entry points and export the expected public API. Run after `pnpm build`.
 * Importing `@g2w/renderer-pixi` also resolves `@g2w/core` through the
 * workspace link and its exports map, so both packages are checked here.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function entryFile(pkgDir) {
  const manifest = JSON.parse(await readFile(path.join(root, pkgDir, "package.json"), "utf8"));
  const exported = manifest.exports["."];
  if (!exported || typeof exported === "string") {
    throw new Error(`${pkgDir}: exports["."] is missing or not an object.`);
  }
  if (!exported.types || !exported.import) {
    throw new Error(`${pkgDir}: exports["."] must declare "types" and "import".`);
  }
  // The declarations must exist on disk, not just be declared.
  const typesPath = path.join(root, pkgDir, exported.types);
  await access(typesPath).catch(() => {
    throw new Error(
      `${pkgDir}: declared types entry ${exported.types} does not exist. Run pnpm build first.`,
    );
  });
  const importPath = path.join(root, pkgDir, exported.import);
  await access(importPath).catch(() => {
    throw new Error(
      `${pkgDir}: declared import entry ${exported.import} does not exist. Run pnpm build first.`,
    );
  });
  return pathToFileURL(importPath);
}

const core = await import(await entryFile("packages/core"));
if (typeof core.RendererError !== "function") {
  throw new Error("@g2w/core does not export RendererError.");
}
if (typeof core.Game !== "function") {
  throw new Error("@g2w/core does not export Game.");
}
if (typeof core.SceneManager !== "function") {
  throw new Error("@g2w/core does not export SceneManager.");
}
if (typeof core.InputState !== "function") {
  throw new Error("@g2w/core does not export InputState.");
}

const inputDom = await import(await entryFile("packages/input-dom"));
if (typeof inputDom.DomInput !== "function") {
  throw new Error("@g2w/input-dom does not export DomInput.");
}

const renderer = await import(await entryFile("packages/renderer-pixi"));
if (typeof renderer.PixiRenderer !== "function") {
  throw new Error("@g2w/renderer-pixi does not export PixiRenderer.");
}

const pixi = new renderer.PixiRenderer();
if (pixi.capabilities.id !== "pixi" || pixi.initialized !== false) {
  throw new Error("@g2w/renderer-pixi: unexpected PixiRenderer state.");
}
await pixi.dispose().then(
  () => {
    throw new Error("PixiRenderer.dispose() should reject before initialization.");
  },
  (error) => {
    if (!(error instanceof core.RendererError)) {
      throw new Error("PixiRenderer.dispose() should reject with RendererError.");
    }
  },
);

console.log("Package exports verified: @g2w/core, @g2w/input-dom, @g2w/renderer-pixi");
