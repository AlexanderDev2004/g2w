# hello-world example

A minimal g2w browser demo showing the **scene system** and the **input system**: the `Game` runtime from `@g2w/core` drives a `PixiRenderer` from `@g2w/renderer-pixi` through the frame loop, a `SceneManager` switches between a **menu** scene and a **gameplay** scene, and a DOM-free `InputState` fed by `@g2w/input-dom`'s `DomInput` provides keyboard and pointer input. This is a real Vite application — it uses only the public exports of the workspace packages.

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
- `onUpdate: (dt) => { scenes.update(dt); input.endFrame(); }` — the active scene is updated by the existing game loop and the input edge states reset once per frame, after every consumer. There is no second loop.
- In the **menu**: the pointer position (canvas-relative) is shown live, and a primary-button click transitions to gameplay — read through `input.wasButtonPressed(0)`, not a DOM click handler.
- In **gameplay**: the square is moved with WASD or the arrow keys (`input.isKeyDown`), and `Esc` returns to the menu (`input.wasKeyPressed("Escape")`). The hint shows how many keys are currently held.
- `await game.init()`, `domInput.attach()`, `scenes.start()`, `game.start()` — startup order: renderer first, then input listeners, then scenes, then the loop.
- `domInput.dispose()`, `scenes.dispose()`, then `game.dispose()` on page teardown (`pagehide`) — the adapter first so no further events reach the state, then scenes, then the game.

PixiJS objects (texts, graphics) are created in this example, at the adapter boundary: core scenes are renderer-agnostic and never touch PixiJS types. There are no DOM event handlers in game logic — everything reads input through the framework API.

If the game cannot start, the error is displayed on the page instead of failing silently.
