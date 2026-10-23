# hello-world example

A minimal g2w browser demo showing the **scene system**: the `Game` runtime from `@g2w/core` drives a `PixiRenderer` from `@g2w/renderer-pixi` through the frame loop, and a `SceneManager` switches between a **menu** scene and a **gameplay** scene. This is a real Vite application — it uses only the public exports of the workspace packages.

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
- `onUpdate: (dt) => scenes.update(dt)` — the active scene is updated by the existing game loop; there is no second loop.
- `scenes.goTo("gameplay")` / `scenes.goTo("menu")` — real transitions on canvas click: the previous scene exits, the next one enters, and only the active scene keeps updating.
- Per-scene update counters on screen — the counters of the inactive scene stay frozen, showing that only the active scene receives updates.
- `await game.init()`, `scenes.start()`, `game.start()` — startup order: renderer first, then scenes, then the loop.
- `scenes.dispose()` then `game.dispose()` on page teardown (`pagehide`) — scenes release their PixiJS objects before the renderer is destroyed.

PixiJS objects (texts, graphics) are created in this example, at the adapter boundary: core scenes are renderer-agnostic and never touch PixiJS types. Click handling is a plain DOM event listener; an input system is out of g2w's scope.

If the game cannot start, the error is displayed on the page instead of failing silently.
