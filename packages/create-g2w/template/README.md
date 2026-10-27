# {{PROJECT_NAME}}

A [g2w](https://github.com/AlexanderDev2004/g2w) game: TypeScript + Vite, 2D, driven by the Effect-native `G2WGame` runtime.

## Prerequisites

- Node.js >= 22
- pnpm (https://pnpm.io)

## Run it

```bash
pnpm install
pnpm dev
```

Open the printed localhost URL. Move the square with WASD or the arrow keys.

## Commands

| Command          | What it does                              |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | Start the Vite dev server with hot reload |
| `pnpm build`     | Production build into `dist/`             |
| `pnpm preview`   | Serve the production build locally        |
| `pnpm test`      | Run unit tests (Vitest)                   |
| `pnpm typecheck` | Type-check all sources (`tsc --noEmit`)   |

## Project layout

```text
index.html              Vite entry page (canvas + error box)
src/main.ts             Application entry: G2WGame wiring, scene, adapters
src/scenes/play-scene.ts Pure player-movement logic (renderer-agnostic, unit-tested)
src/vite-env.d.ts       Vite client types
test/                   Unit tests (Vitest, deterministic, no browser)
```

## Dependencies

- `@g2w/core` — engine contracts: scenes, input state, renderer contract.
- `@g2w/runtime` — `G2WGame`, the Effect-based application lifecycle.
- `@g2w/renderer-pixi` — PixiJS 8 renderer implementing the core contract.
- `@g2w/input-dom` — browser keyboard/pointer adapter feeding `InputState`.
- `pixi.js` — the rendering library (peer of `@g2w/renderer-pixi`).

Note: the `@g2w/*` packages are consumed at version `0.1.0`. If npm reports
that these packages cannot be resolved, they are not published yet — see the
[g2w roadmap](https://github.com/AlexanderDev2004/g2w/blob/main/ROADMAP.md)
(R10) for the publishing plan. Until then, g2w templates are validated
against locally packed package tarballs
(`node scripts/smoke-create-g2w.mjs` in the g2w repository).

## License

MIT
