# g2w

**g2w — Game to Website** is a TypeScript-first, AI-agent-ready framework for building and shipping web games: HTML5 games, 2D first with 3D planned, for desktop and mobile web browsers.

> **Status: early foundation (MVP 0).** The repository currently establishes the monorepo, the renderer-agnostic core contract, and a PixiJS adapter skeleton. There is no game loop, scene system, or playable demo yet. See [What is implemented](#what-is-implemented) below.

## Architecture

g2w is a pnpm monorepo of small packages with one strict rule: **`@g2w/core` never depends on a rendering technology.** Renderers implement the core contract and depend on core, never the other way around.

```text
packages/core/src/index.ts        Renderer contract + RendererError
packages/renderer-pixi/src/       PixiJS implementation of that contract
examples/hello-world/             Foundation example with a fake renderer
docs/architecture.md              Architecture decisions and direction
```

For the full picture, read [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 22 or newer
- pnpm 12 (activated automatically via `packageManager`, e.g. through Corepack)

## Getting started

```sh
pnpm install
```

## Development commands

| Command               | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm build`          | Type-check and build all packages to `dist/`            |
| `pnpm typecheck`      | Type-check all sources, tests, and examples (no output) |
| `pnpm check`          | Format and lint check with Biome                        |
| `pnpm format`         | Auto-format sources with Biome                          |
| `pnpm test`           | Run all tests with Vitest                               |
| `pnpm verify:exports` | Verify built packages load through their entry points   |

## What is implemented

- **Monorepo foundation** — pnpm workspaces, strict TypeScript (`tsconfig.base.json`), Biome formatting and linting, Vitest tests, GitHub Actions CI (`.github/workflows/ci.yml`).
- **Renderer contract** — `@g2w/core` defines `Renderer`, `RendererCapabilities`, `RendererInitOptions`, and `RendererError`. Core has zero runtime dependencies and no PixiJS dependency; tests enforce this boundary.
- **PixiJS adapter** — `@g2w/renderer-pixi` implements the contract with PixiJS 8's async `Application` lifecycle. It is a minimal adapter, not a complete renderer yet.
- **Example** — `examples/hello-world` demonstrates the contract with a fake renderer. A browser demo that actually draws is planned for MVP 1.

## What is planned (not implemented yet)

- Game loop and lifecycle management, scenes, sprites, input, assets, audio, physics.
- A Vite starter and project-generation CLI.
- A Three.js adapter for 3D.
- Optional integrations for React, Vue, Next.js, Bun, and Effect.

Packages are not published to npm yet; the workspace is for local development and CI.
