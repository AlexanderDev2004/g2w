# Architecture

## Goal

g2w is a TypeScript-first framework for building and shipping web games. 2D comes first with PixiJS as the initial rendering foundation; a Three.js adapter for 3D is planned for later. The long-term direction also includes optional integrations (React, Vue, Next.js, Bun, Effect) and AI-agent-friendly workflows, which are documented as roadmap items, not implemented.

## Packages and responsibilities

### `@g2w/core`

Owns the renderer-agnostic **contract**: what a renderer is, how it is initialized against a canvas, and how it releases its resources. Concretely, the public API is:
- `Renderer` — the lifecycle contract (`capabilities`, `initialized`, `initialize`, `dispose`).
- `RendererCapabilities` — renderer identity (`id`, `displayName`).
- `RendererInitOptions` — canvas, optional background color, optional resolution.
- `RendererError` — thrown for invalid lifecycle usage.

Core has **zero runtime dependencies** and **no rendering technology imports**. It will grow to own the game loop, scenes, and other framework services, but every rendering capability stays behind the contract.

### `@g2w/renderer-pixi`

Implements the core contract on top of PixiJS 8. It wraps a PixiJS `Application`: async `initialize()` mirrors PixiJS v8's async `Application.init()`, and `dispose()` destroys the application while leaving a caller-provided canvas in the DOM (`removeView: false`). At MVP 0 this is a minimal adapter, not a complete renderer: no scene, sprites, or render loop yet.

## Dependency direction

The single most important rule: **core must never depend on a renderer; renderers always depend on core.**

```text
┌──────────────────┐                ┌──────────────────────────┐
│    @g2w/core     │ ◄── depends on ┤    @g2w/renderer-pixi    │
│ renderer contract│                │ PixiJS implementation    │
│ no PixiJS imports│                │ depends on PixiJS        │
└──────────────────┘                └──────────────────────────┘
         ▲
         │ depends on
         │
┌────────┴───────────────────────────────────────────────────┐
│ future renderer packages (e.g. @g2w/renderer-three)        │
└────────────────────────────────────────────────────────────┘
```

Why core stays renderer-agnostic:
- Game code written against `@g2w/core` survives switching or upgrading renderers.
- The core framework (loop, scenes, assets) cannot accidentally couple to PixiJS APIs.
- A Three.js renderer can be added later without touching core.
- Core stays testable without a browser, GPU, or WebGL context.

## Dependency direction enforcement

- `packages/core/test/architecture.test.ts` asserts core declares no runtime dependencies, no `pixi.js` dependency in any group, and no renderer imports in its source.
- `packages/renderer-pixi/test/pixi-renderer.test.ts` asserts the adapter declares `@g2w/core` as a dependency and that core does not depend back on the adapter.
- `pnpm verify:exports` (also run in CI) loads the built packages through their real entry points.

## Tooling decisions

- **pnpm workspaces** for the monorepo; `workspace:*` links between packages.
- **TypeScript** with `NodeNext` module resolution, ESM-only packages, and strict settings (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`). Packages are built with `tsc -b` project references — no bundler at this stage.
- **Biome** for formatting and linting (`pnpm check`).
- **Vitest** for tests, running against package sources via a resolve alias so tests do not require a prior build. Core tests use a fake renderer and never need a browser or GPU.
- **pixi.js 8.22** as a dev dependency of the adapter with a `>=8` peer dependency, so consumers' PixiJS version is respected.

## Current vs provisional

Current (MVP 0):
- The `Renderer` contract above and the dependency direction it enforces.
- PixiJS 8 async lifecycle handling and dispose semantics (canvas stays in the DOM).
- ESM-only packages with `exports` maps pointing at `dist/`.

Provisional (expect to change in later MVPs):
- The exact shape of `RendererInitOptions`; it will likely grow as core learns about sizing, scaling, and backends.
- The PixiJS adapter's internals; it will be reworked once core owns the game loop.
- The test aliasing setup; it may move to package-level configs when the workspace grows.
