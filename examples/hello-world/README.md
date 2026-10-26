# hello-world example

A minimal g2w browser demo showing the **asset system**, the **scene system**, the **input system**, and the **2D sprite model**: the `Game` runtime from `@g2w/core` drives a `PixiRenderer` from `@g2w/renderer-pixi` through the frame loop, a `SceneManager` switches between a **menu** scene and a **gameplay** scene, a DOM-free `InputState` fed by `@g2w/input-dom`'s `DomInput` provides keyboard and pointer input, a texture asset manager from `@g2w/renderer-pixi` loads the local image, and the image is rendered through a core `Sprite2D`/`Transform2D` model driven by a `createSpriteView()` view from `@g2w/renderer-pixi`. This is a real Vite application — it uses only the public exports of the workspace packages.

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
- `new Sprite2D({ texture, transform: new Transform2D({ x, y }) })` + `createSpriteView({ sprite, renderer })` — the sprite path: game logic mutates the renderer-agnostic `Sprite2D`/`Transform2D` model and calls `logoView.sync()` once per change; the PixiJS adapter applies the transform to its display object. The gameplay scene animates the logo's rotation and scale purely through the model. The view is created once and reused across scene transitions — visibility is toggled through `logoModel.visible` plus `sync()`, so no sprite is duplicated.
- `onUpdate: (dt) => { scenes.update(dt); input.endFrame(); }` — the active scene is updated by the existing game loop and the input edge states reset once per frame, after every consumer. There is no second loop.
- In the **menu**: the pointer position (canvas-relative) is shown live, and a primary-button click transitions to gameplay — read through `input.wasButtonPressed(0)`, not a DOM click handler.
- In **gameplay**: the square is moved with WASD or the arrow keys (`input.isKeyDown`), and `Esc` returns to the menu (`input.wasKeyPressed("Escape")`). The hint shows how many keys are currently held.
- Startup order: assets are loaded first (`loading assets…` note until the texture arrives, and the error box if loading fails), then `await game.init()` initializes the renderer — `createSpriteView()` needs the initialized stage and is called right after — then `domInput.attach()`, `scenes.start()`, `game.start()`.
- `domInput.dispose()`, `scenes.dispose()`, then `game.dispose()` followed by `assets.dispose()` on page teardown (`pagehide`) — the adapter first so no further events reach the state, then scenes (they destroy their display objects and the logo sprite view, never their textures), then the game, and finally the asset manager, which releases only its own references: manager disposal never destroys textures from PixiJS's shared `Assets` cache (the page unload reclaims them).
- In dev mode only (`if (import.meta.env.DEV)`), the demo dynamically imports `@g2w/devtools` and opens the read-only overlay over the scene manager, the spark object collection, and the input state (with an explicit watch list). It is disposed first on `pagehide` — before the runtime it observes — and production builds (`pnpm build:example`) exclude it entirely.

PixiJS objects (texts, graphics, the logo sprite) are created at the adapter boundary: core scenes and game logic are renderer-agnostic and never touch PixiJS types. Ownership is split explicitly — scenes own and destroy their own display objects (texts, graphics), the sprite view owns only its display object (`logoView.dispose()` removes and destroys it but never the texture), the asset manager caches and deduplicates textures but never destroys them (they live in PixiJS's shared `Assets` cache until the page unloads), and the caller owns the manager itself. There are no DOM event handlers in game logic — everything reads input through the framework API — no direct PixiJS `Assets` calls in game logic — everything loads through the public asset API — and no direct PixiJS sprite manipulation in game logic — everything renders through `Sprite2D`/`Transform2D` plus `createSpriteView()`.

If the game cannot start, the error is displayed on the page instead of failing silently.
