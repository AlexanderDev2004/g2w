# hello-world example

A minimal g2w browser demo showing the **asset system**, the **scene system**, and the **input system**: the `Game` runtime from `@g2w/core` drives a `PixiRenderer` from `@g2w/renderer-pixi` through the frame loop, a `SceneManager` switches between a **menu** scene and a **gameplay** scene, a DOM-free `InputState` fed by `@g2w/input-dom`'s `DomInput` provides keyboard and pointer input, and a texture asset manager from `@g2w/renderer-pixi` loads the local image shown in the gameplay scene. This is a real Vite application — it uses only the public exports of the workspace packages.

## Run it

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Then open the printed local URL (for example `http://localhost:5173/`) in a browser. Vite serves the example with the workspace package sources aliased directly, so no prior build is needed.

## What it demonstrates

- `new Game({ renderer, canvas, onUpdate })` — constructing the runtime with the PixiJS adapter and a canvas.
- `new SceneManager({ scenes, initial: "menu" })` — registering two scenes and starting with the menu.
- `new InputState()` + `new DomInput(input, { canvas })` — the input path: a DOM-free state from `@g2w/core`, fed by real browser events from `@g2w/input-dom`.
- `createTextureAssetManager()` + `await assets.load("assets/g2w-logo.png")` — the asset path: the app creates and owns one texture asset manager from `@g2w/renderer-pixi`; the local image is loaded through the public asset API and shown in the gameplay scene. A second request for the same URL is served from the cache — the menu shows `texture cache: hit` to prove it.
- `onUpdate: (dt) => { scenes.update(dt); input.endFrame(); }` — the active scene is updated by the existing game loop and the input edge states reset once per frame, after every consumer. There is no second loop.
- In the **menu**: the pointer position (canvas-relative) is shown live, and a primary-button click transitions to gameplay — read through `input.wasButtonPressed(0)`, not a DOM click handler.
- In **gameplay**: the square is moved with WASD or the arrow keys (`input.isKeyDown`), and `Esc` returns to the menu (`input.wasKeyPressed("Escape")`). The hint shows how many keys are currently held.
- `await game.init()`, `domInput.attach()`, `scenes.start()`, `game.start()` — startup order: assets are loaded before the runtime starts, so the page shows a `loading assets…` note until the texture arrives (and the error box if loading fails).
- `domInput.dispose()`, `scenes.dispose()`, then `game.dispose()` followed by `assets.dispose()` on page teardown (`pagehide`) — the adapter first so no further events reach the state, then scenes (they destroy their sprites, never their textures), then the game, and finally the asset manager, which releases only its own references: manager disposal never destroys textures from PixiJS's shared `Assets` cache (the page unload reclaims them).

PixiJS objects (texts, graphics, the logo sprite) are created in this example, at the adapter boundary: core scenes are renderer-agnostic and never touch PixiJS types. Ownership is split explicitly — scenes own and destroy their display objects (`sprite.destroy()` does not touch the texture), the asset manager caches and deduplicates textures but never destroys them (they live in PixiJS's shared `Assets` cache until the page unloads), and the caller owns the manager itself. There are no DOM event handlers in game logic — everything reads input through the framework API — and no direct PixiJS `Assets` calls in game logic — everything loads through the public asset API.

If the game cannot start, the error is displayed on the page instead of failing silently.
