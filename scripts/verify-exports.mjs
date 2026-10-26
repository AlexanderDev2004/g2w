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
if (typeof core.Anchor2D !== "function") {
  throw new Error("@g2w/core does not export Anchor2D.");
}
if (typeof core.SpriteError !== "function") {
  throw new Error("@g2w/core does not export SpriteError.");
}
if (typeof core.GameObjectCollection !== "function") {
  throw new Error("@g2w/core does not export GameObjectCollection.");
}
if (typeof core.AudioManager !== "function") {
  throw new Error("@g2w/core does not export AudioManager.");
}
if (typeof core.AudioError !== "function") {
  throw new Error("@g2w/core does not export AudioError.");
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
model.anchor.set(0.5, 0.5);
model.zIndex = 4;
view.sync();
const spriteDisplay = spriteStage.children[0];
if (spriteDisplay.x !== 30 || spriteDisplay.y !== 20) {
  throw new Error("@g2w/renderer-pixi: sync did not apply the model transform.");
}
if (spriteDisplay.anchor.x !== 0.5 || spriteDisplay.anchor.y !== 0.5) {
  throw new Error("@g2w/renderer-pixi: sync did not apply the model anchor.");
}
if (spriteDisplay.zIndex !== 4) {
  throw new Error("@g2w/renderer-pixi: sync did not apply the model z-order.");
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

// Exercise the game-object pipeline through the real entry points: a core
// object registered in a collection, updated once, destroyed â€” with a fake
// texture (a destroy() flag) proving no cleanup ever destroys it.
const objectAssets = renderer.createTextureAssetManager({
  load: async () => ({
    destroy() {
      objectDestroyed = true;
    },
  }),
});
let objectDestroyed = false;
const objectTexture = await objectAssets.load("fake/object.png");
const objectSprite = new core.Sprite2D({ texture: objectTexture });
const objects = new core.GameObjectCollection();
const gameObject = {
  transform: objectSprite.transform,
  update(deltaTime) {
    objectSprite.transform.x += 10 * deltaTime;
  },
  destroy() {
    objectSprite.visible = false;
  },
};
objects.add(gameObject);
objects.update(0.5);
if (objectSprite.transform.x !== 5) {
  throw new Error("@g2w/core: GameObjectCollection.update did not drive the object.");
}
if ((await objectAssets.load("fake/object.png")) !== objectTexture) {
  throw new Error("@g2w/renderer-pixi: repeated object-asset loads did not reuse the cache.");
}
objects.destroy();
if (objectSprite.visible !== false) {
  throw new Error("@g2w/core: GameObjectCollection.destroy did not run the destroy hook.");
}
if (objectDestroyed) {
  throw new Error("@g2w/core: object cleanup destroyed a shared texture (R1 violation).");
}
try {
  objects.update(1);
  throw new Error("Updating a destroyed GameObjectCollection should throw.");
} catch (error) {
  if (!(error instanceof core.SceneError)) {
    throw new Error("Updating a destroyed GameObjectCollection should throw SceneError.");
  }
}

// Exercise the audio pipeline through the real entry points: a core
// AudioManager over an injected fake backend (no browser), loading once,
// playing twice, stopping all, and disposing terminally.
const audioWeb = await import(await entryFile("packages/audio-web"));
if (
  typeof audioWeb.WebAudioBackend !== "function" ||
  typeof audioWeb.WebAudioError !== "function"
) {
  throw new Error("@g2w/audio-web does not export WebAudioBackend/WebAudioError.");
}
let audioBackendDisposed = false;
const audioBackendLoads = [];
const audio = new core.AudioManager({
  backend: {
    load: async (key) => {
      audioBackendLoads.push(key);
      return {
        play: (options) => {
          if (options?.volume !== 0.5) {
            throw new audioWeb.WebAudioError("unexpected play options");
          }
          return { stopped: false, stop() {} };
        },
      };
    },
    dispose: () => {
      audioBackendDisposed = true;
    },
  },
});
const laser = await audio.load("fake/laser.wav");
const laserPlayback = await audio.play("fake/laser.wav", { volume: 0.5 });
if (audioBackendLoads.length !== 1 || laserPlayback.stopped !== false) {
  throw new Error("@g2w/core: AudioManager did not load once and start one playback.");
}
laser.play({ volume: 0.5 });
audio.stopAll();
audio.dispose();
if (!audioBackendDisposed) {
  throw new Error("@g2w/core: AudioManager.dispose did not release the backend.");
}
try {
  audio.load("fake/laser.wav");
  throw new Error("Loading from a disposed AudioManager should throw.");
} catch (error) {
  if (!(error instanceof core.AudioError)) {
    throw new Error("Loading from a disposed AudioManager should throw AudioError.");
  }
}

// Exercise the gamepad pipeline through the real entry points: a core
// GamepadState over an injected fake source (no hardware, no browser),
// sampling once, and terminal idempotent disposal.
const inputGamepad = await import(await entryFile("packages/input-gamepad"));
if (
  typeof inputGamepad.GamepadInput !== "function" ||
  typeof inputGamepad.GamepadInputError !== "function"
) {
  throw new Error("@g2w/input-gamepad does not export GamepadInput/GamepadInputError.");
}
const gamepadState = new core.GamepadState();
const gamepadInput = new inputGamepad.GamepadInput(gamepadState, {
  source: () => [{ index: 0, pressed: [true], axes: [0.25, -0.5] }, null],
  connectTarget: new EventTarget(),
  disconnectTarget: new EventTarget(),
});
gamepadInput.attach();
gamepadInput.poll();
if (
  !gamepadState.isConnected(0) ||
  !gamepadState.isButtonDown(0, 0) ||
  gamepadState.getAxis(0, 1) !== -0.5
) {
  throw new Error("@g2w/input-gamepad: poll() did not feed the sampled controller.");
}
gamepadState.endFrame();
gamepadInput.dispose();
gamepadInput.dispose(); // idempotent
try {
  gamepadInput.attach();
  throw new Error("Attaching a disposed GamepadInput should throw.");
} catch (error) {
  if (!(error instanceof inputGamepad.GamepadInputError)) {
    throw new Error("Attaching a disposed GamepadInput should throw GamepadInputError.");
  }
}

// Exercise the runtime pipeline through the real entry points: bootstrap a
// managed Effect runtime from a layer with an acquired resource (no browser),
// run a program, register a finalizer, shut down once, and verify shutdown
// idempotence plus the run-after-shutdown guard.
const runtimePackage = await import(await entryFile("packages/runtime"));
if (
  typeof runtimePackage.createG2WRuntime !== "function" ||
  typeof runtimePackage.RuntimeBootstrapError !== "function" ||
  typeof runtimePackage.RuntimeCleanupFailure !== "function" ||
  typeof runtimePackage.RuntimeShutdownError !== "function"
) {
  throw new Error("@g2w/runtime does not export createG2WRuntime or its typed errors.");
}
// Effect is a dependency of @g2w/runtime only; under pnpm's strict layout it
// resolves from the runtime package's own node_modules, not the repo root.
const { Effect, Layer } = await import(
  pathToFileURL(
    path.join(root, "packages", "runtime", "node_modules", "effect", "dist", "index.js"),
  ).href
);
let runtimeLayerReleased = false;
const runtimeLayer = Layer.effectDiscard(
  Effect.acquireRelease(Effect.void, () =>
    Effect.sync(() => {
      runtimeLayerReleased = true;
    }),
  ),
);
const runtime = await runtimePackage.createG2WRuntime({ layer: runtimeLayer });
let runtimeFinalizerRan = false;
runtime.addFinalizer(() => {
  runtimeFinalizerRan = true;
});
const runtimeValue = await runtime.run(Effect.succeed(7));
if (runtimeValue !== 7) {
  throw new Error("@g2w/runtime: run() did not execute the program.");
}
await runtime.shutdown();
if (!runtimeFinalizerRan || !runtimeLayerReleased || runtime.disposed !== true) {
  throw new Error("@g2w/runtime: shutdown() did not run finalizers and layer disposal.");
}
await runtime.shutdown(); // idempotent: cleanup must not run twice
if (!runtimeFinalizerRan || !runtimeLayerReleased) {
  throw new Error("@g2w/runtime: repeated shutdown executed cleanup again.");
}
let runtimeGuardThrew = false;
try {
  runtime.run(Effect.succeed(1));
} catch (error) {
  runtimeGuardThrew = error instanceof runtimePackage.RuntimeShutdownError;
}
if (!runtimeGuardThrew) {
  throw new Error("@g2w/runtime: run() after shutdown should throw RuntimeShutdownError.");
}

// Exercise the DevTools pipeline through the real entry points, using the
// same fake DOM approach as the unit tests: build the overlay, feed it a
// collection snapshot, and dispose it â€” proving the package's public surface
// works and that disposal never touches the sources it read from.
const devtools = await import(await entryFile("packages/devtools"));
if (typeof devtools.DevTools !== "function" || typeof devtools.createDevTools !== "function") {
  throw new Error("@g2w/devtools does not export DevTools/createDevTools.");
}
const fakeDoc = {
  body: fakeElement("body"),
  createElement: (tag) => fakeElement(tag),
};
function fakeElement(tag) {
  return {
    tag,
    style: { cssText: "", display: "" },
    dataset: {},
    textContent: "",
    disabled: false,
    title: "",
    children: [],
    parent: null,
    listeners: new Map(),
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parent) {
        const index = this.parent.children.indexOf(this);
        if (index !== -1) {
          this.parent.children.splice(index, 1);
        }
        this.parent = null;
      }
    },
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [...children];
      for (const child of children) child.parent = this;
    },
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    },
  };
}
function findText(element, fragment) {
  if (element.textContent.includes(fragment)) {
    return element;
  }
  for (const child of element.children) {
    const found = findText(child, fragment);
    if (found) {
      return found;
    }
  }
  return null;
}
const liveCollection = new core.GameObjectCollection();
liveCollection.add({ transform: new core.Transform2D({ x: 1, y: 2 }) });
const inspector = devtools.createDevTools({
  objects: liveCollection,
  document: /** @type {Document} */ (/** @type {unknown} */ (fakeDoc)),
  scheduler: {
    requestFrame: () => 1,
    cancelFrame: () => {},
  },
});
inspector.open();
if (fakeDoc.body.children.length !== 1) {
  throw new Error("@g2w/devtools: open() did not attach the overlay.");
}
if (findText(fakeDoc.body, "pos(1.0, 2.0)") === null) {
  throw new Error("@g2w/devtools: object list did not render the collection snapshot.");
}
inspector.dispose();
if (fakeDoc.body.children.length !== 0 || inspector.disposed !== true) {
  throw new Error("@g2w/devtools: dispose() did not remove the overlay.");
}
// The read source is untouched by DevTools disposal.
if (liveCollection.size !== 1) {
  throw new Error("@g2w/devtools: disposal mutated the observed collection.");
}

const pixi = new renderer.PixiRenderer();
if (pixi.capabilities.id !== "pixi" || pixi.initialized !== false) {
  throw new Error("@g2w/renderer-pixi: unexpected PixiRenderer state.");
}
if (typeof pixi.resize !== "function") {
  throw new Error("@g2w/renderer-pixi: PixiRenderer does not expose resize (R3 sizing contract).");
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
  "Package exports verified: @g2w/core, @g2w/input-dom, @g2w/input-gamepad, @g2w/renderer-pixi, @g2w/audio-web, @g2w/devtools, @g2w/runtime (incl. asset + sprite + game-object + audio + gamepad + devtools + runtime API)",
);
