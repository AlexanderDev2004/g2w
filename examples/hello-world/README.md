# hello-world example

A minimal g2w browser demo: the `Game` runtime from `@g2w/core` drives a `PixiRenderer` from `@g2w/renderer-pixi` through the frame loop, animating a yellow square across a blue canvas. This is a real Vite application — it uses only the public exports of the workspace packages.

## Run it

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Then open the printed local URL (for example `http://localhost:5173/`) in a browser. Vite serves the example with the workspace package sources aliased directly, so no prior build is needed.

## What it demonstrates

- `new Game({ renderer, canvas, onUpdate })` — constructing the runtime with the PixiJS adapter and a canvas.
- `await game.init()` — asynchronous renderer initialization (PixiJS 8 lifecycle).
- `game.start()` — the frame loop: `onUpdate(deltaTime)` runs each frame with the elapsed time in seconds, then the renderer renders.
- `game.dispose()` on page teardown (`pagehide`) — the loop stops and the renderer is disposed.

If the game cannot start, the error is displayed on the page instead of failing silently.
