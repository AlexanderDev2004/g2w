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
if (typeof core.AssetManager !== "function") {
  throw new Error("@g2w/core does not export AssetManager.");
}
if (typeof core.AssetError !== "function") {
  throw new Error("@g2w/core does not export AssetError.");
}
if (typeof core.Transform2D !== "function") {
  throw new Error("@g2w/core does not export Transform2D.");
}
if (typeof core.Sprite2D !== "function") {
  throw new Error("@g2w/core does not export Sprite2D.");
}

const inputDom = await import(await entryFile("packages/input-dom"));
if (typeof inputDom.DomInput !== "function") {
  throw new Error("@g2w/input-dom does not export DomInput.");
}

const renderer = await import(await entryFile("packages/renderer-pixi"));
if (typeof renderer.PixiRenderer !== "function") {
  throw new Error("@g2w/renderer-pixi does not export PixiRenderer.");
}
if (typeof renderer.createTextureAssetManager !== "function") {
  throw new Error("@g2w/renderer-pixi does not export createTextureAssetManager.");
}
if (typeof renderer.createSpriteView !== "function") {
  throw new Error("@g2w/renderer-pixi does not export createSpriteView.");
}

// Exercise the sprite model -> view pipeline through the real entry points.
// The fake texture handle proves the core model and the view creation do not
// require a PixiJS Texture object (nothing renders in Node).
const model = new core.Sprite2D({
  texture: "fake-handle",
  transform: new core.Transform2D({ x: 10, y: 20 }),
});
const spriteStage = {
  children: [],
  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  },
  // PixiJS Container.removeChild is what Sprite#removeFromParent() delegates to.
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    child.parent = null;
    return child;
  },
};
const view = renderer.createSpriteView({ sprite: model, renderer: { stage: spriteStage } });
if (spriteStage.children.length !== 1) {
  throw new Error("@g2w/renderer-pixi: createSpriteView did not attach one display object.");
}
model.transform.x = 30;
view.sync();
const spriteDisplay = spriteStage.children[0];
if (spriteDisplay.x !== 30 || spriteDisplay.y !== 20) {
  throw new Error("@g2w/renderer-pixi: sync did not apply the model transform.");
}
view.dispose();
if (!view.disposed || spriteStage.children.length !== 0) {
  throw new Error("@g2w/renderer-pixi: sprite view disposal did not detach the display object.");
}

// Exercise the asset pipeline end to end through the real entry points, with
// an injected loader so no network or browser is needed. The fake mimics the
// texture surface (destroy()) so the test proves the adapter never calls it.
let fakeDestroyed = false;
const assets = renderer.createTextureAssetManager({
  load: async (key) => ({
    key,
    destroy() {
      fakeDestroyed = true;
    },
  }),
});
const texture = await assets.load("fake/logo.png");
if (texture.key !== "fake/logo.png") {
  throw new Error("@g2w/renderer-pixi: createTextureAssetManager did not return the loaded value.");
}
if ((await assets.load("fake/logo.png")) !== texture) {
  throw new Error("@g2w/renderer-pixi: repeated asset loads did not reuse the cached value.");
}
await assets.dispose();
if (assets.disposed !== true) {
  throw new Error("@g2w/renderer-pixi: asset manager disposal did not complete.");
}
if (fakeDestroyed) {
  throw new Error(
    "@g2w/renderer-pixi: manager disposal destroyed a texture from the shared Assets cache.",
  );
}
try {
  assets.load("fake/logo.png");
  throw new Error("Loading from a disposed asset manager should throw.");
} catch (error) {
  if (!(error instanceof core.AssetError)) {
    throw new Error("Loading from a disposed asset manager should throw AssetError.");
  }
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

console.log(
  "Package exports verified: @g2w/core, @g2w/input-dom, @g2w/renderer-pixi (incl. asset + sprite API)",
);
