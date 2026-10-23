# AGENTS.md

Guidance for AI coding agents (Amp and others) working in this repository.

## Project

**g2w (Game to Website)** is a TypeScript-first, AI-agent-ready framework for building and shipping web games. 2D first with PixiJS; 3D via a future Three.js adapter. The repository is at **MVP 1E — 2D transform & sprite API**: monorepo, renderer contract, `Game` lifecycle and frame loop, renderer-agnostic `SceneManager`, DOM-free `InputState` with the `@g2w/input-dom` browser adapter, a generic `AssetManager` in core with the `@g2w/renderer-pixi` texture loader, the `Transform2D`/`Sprite2D` model in core with the adapter's `createSpriteView`, minimal PixiJS adapter, a Vite browser demo, tests, CI, and docs.

## Architecture boundaries

- `@g2w/core` (packages/core) owns the renderer-agnostic contract, the `Game` runtime, the `SceneManager`, the DOM-free `InputState`, the generic `AssetManager`, and the `Transform2D`/`Sprite2D` model. It must never import a rendering technology or touch browser globals/DOM events at runtime, and must keep zero runtime dependencies.
- `@g2w/renderer-pixi` (packages/renderer-pixi) implements the renderer contract on top of PixiJS and adapts texture loading (`createTextureAssetManager`) and sprite rendering (`createSpriteView`) to the core model. It may depend on `@g2w/core` and PixiJS. The dependency must never point the other way.
- `@g2w/input-dom` (packages/input-dom) adapts real browser events onto the core `InputState`. It may depend on `@g2w/core` only; all DOM event handling lives here, never in core.
- `examples/hello-world` consumes only the public exports of both packages through Vite; it must not bypass g2w by creating a PixiJS `Application` directly.
- Tests in `packages/core/test/architecture.test.ts`, `packages/core/test/game.test.ts`, `packages/core/test/scene-manager.test.ts`, `packages/core/test/input.test.ts`, `packages/core/test/asset-manager.test.ts`, `packages/input-dom/test/`, and `packages/renderer-pixi/test/` enforce these boundaries — keep them passing and extend them when adding packages.

## Commands

All commands run from the repository root with pnpm:
- `pnpm install` — install dependencies (lockfile `pnpm-lock.yaml` is committed; use `--frozen-lockfile` in CI).
- `pnpm dev` — run the hello-world browser demo with Vite (workspace sources aliased; no build needed first).
- `pnpm build` — type-check and build packages via `tsc -b` project references.
- `pnpm build:example` — production build of the browser demo.
- `pnpm typecheck` — type-check all sources, tests, and examples (`tsc -p tsconfig.check.json --noEmit`).
- `pnpm check` — Biome format + lint check.
- `pnpm format` — Biome auto-format.
- `pnpm test` — Vitest run (uses source aliases; no build required first).
- `pnpm verify:exports` — verify built packages load through their entry points (run after `pnpm build`).

Validate with `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm verify:exports`, and `pnpm test` before finishing any change. CI (`.github/workflows/ci.yml`) runs exactly these commands plus `pnpm build:example`.

## Conventions

- TypeScript strict mode everywhere (`tsconfig.base.json`): no implicit `any`, `noUncheckedIndexedAccess`, unused declaration checks, `verbatimModuleSyntax` (use `import type` for type-only imports).
- ESM-only packages, NodeNext module resolution, `.js` extensions in relative imports.
- Named exports only; no default exports.
- Public API is small and explicit; prefer readonly types for shared options and capabilities.
- `Game` lifecycle changes must keep the documented state model (README / docs/architecture.md) and its tests in sync — the state transitions are a public contract.
- Core lifecycle tests must stay deterministic: drive frames through the injected `FrameScheduler` fake, never real timers or a browser.
- Scene tests must stay deterministic: drive transitions through `SceneManager` directly, never real timers or a browser.
- Input tests must stay deterministic: feed `InputState` through its `handle*` methods and drive the DOM adapter with fake event targets, never real timers or a browser.
- Asset tests must stay deterministic: inject loaders (deferred promises and fake assets) into `AssetManager`/`createTextureAssetManager`, never real timers, network, or a browser.
- No new dependencies without a clear need. `@g2w/core` stays dependency-free.
- Do not enable `skipLibCheck: false`-style weakening or suppress type errors; fix the underlying issue.
- Biome owns formatting (2-space indent, 100-char lines) — run `pnpm format` rather than hand-formatting.

## Scope discipline

- Do not expand beyond the current MVP scope without explicit approval. Out of scope as of MVP 1D: gamepad support, touch gestures, action mapping or rebinding, input recording, scene stacks, transition effects, scene persistence, game objects, audio, sprite batching helpers, texture atlases, manifest-based bulk loading, physics, animations, cameras, integrations (React/Vue/Next.js/Effect), multiplayer, MCP servers, 3D runtime, npm publishing, release automation.
- Document planned-but-unimplemented features as roadmap items in the README or docs, never as stubs or placeholder code.

## Definition of done

A change is done when:
1. It implements the requested behavior and nothing more.
2. `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm verify:exports`, and `pnpm test` all pass.
3. Documentation touched by the change (README, docs/architecture.md, this file) still matches the implementation, including every documented command.
4. The diff contains no unrelated changes, no leftover dead code, and no untracked build artifacts (`dist/`, `*.tsbuildinfo` are gitignored).
