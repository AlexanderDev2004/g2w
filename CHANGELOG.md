# Changelog

All notable changes to the G2W packages are documented here. All eight
publishable packages share one version (fixed-version monorepo policy — see
[docs/release.md](docs/release.md)).

## 0.1.0 — 2026-10-28

The first public release of the g2w framework: a TypeScript-first, AI-agent-ready
framework for building and shipping 2D web games with PixiJS.

### Packages released

| Package              | Description                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@g2w/core`          | Renderer-agnostic core contracts: `Game` lifecycle and frame loop, `SceneManager`, DOM-free `InputState` (keyboard, pointer, multi-touch) and `GamepadState`, generic `AssetManager`, `Transform2D`/`Sprite2D`, `GameObject`/`GameObjectCollection`, `AudioManager`, and the renderer contract with a shared conformance suite. Zero runtime dependencies. |
| `@g2w/renderer-pixi` | PixiJS renderer adapter: the `Renderer` contract, texture asset loading (`createTextureAssetManager`), sprite views (`createSpriteView`), optional backend preference and actual-backend reporting (WebGL/WebGPU/Canvas via PixiJS `preference` and `renderer.name`).                                                                                      |
| `@g2w/input-dom`     | Browser input adapter: real DOM events (Pointer Events) onto the core `InputState`. Failure-safe attach/dispose lifecycle: shared in-flight initialization, transactional registration with retryable cleanup, idempotent disposal.                                                                                                                        |
| `@g2w/input-gamepad` | Gamepad API adapter: samples gamepads onto the core `GamepadState` through an injectable polling source the host drives with `poll()`. Same failure-safe lifecycle as the DOM adapter.                                                                                                                                                                     |
| `@g2w/audio-web`     | Web Audio adapter: implements the core audio backend contract — decodes sound files, starts playbacks, owns the `AudioContext` lifecycle.                                                                                                                                                                                                                  |
| `@g2w/devtools`      | Read-only runtime overlay for development: observes core state through immutable snapshots, never mutates or disposes the runtime.                                                                                                                                                                                                                         |
| `@g2w/runtime`       | Effect-based runtime foundation: one managed Effect runtime, explicit idempotent shutdown, best-effort finalizer cleanup with observable failures, and `G2WGame` — the core game lifecycle orchestrated through the managed runtime (the primary application path used by the browser demo; the core `Game` remains the reference implementation).         |
| `create-g2w`         | Zero-dependency project-scaffolding CLI: generates a TypeScript + Vite starter game from a bundled template (public `@g2w/*` APIs only, pinned versions, explicit lifecycle cleanup, local `git init`).                                                                                                                                                    |

### Notable capabilities

- Renderer backend selection (`RendererInitOptions.backend`) and reporting
  (`RendererCapabilities.backend`), with a shared renderer conformance suite
  and browser-verified WebGL/WebGPU/Canvas backends including per-backend
  feature verification.
- Failure-safe adapter lifecycles for the renderer and both input adapters:
  shared in-flight initialization, rollback of partial registration with
  retryable cleanup, and deterministic disposal — including
  dispose-during-initialization.
- Effect as the primary application runtime (`G2WGame`) with the frame hot
  path free of Effect allocations; `@g2w/core` stays dependency-free and
  Effect-free.
- The `create-g2w` starter validated end to end against packed tarballs
  (`pnpm test:pack`) with an external TypeScript + Vite consumer, plus a
  headless-browser smoke test of the scaffolded game.

### Release infrastructure

- Fixed-version monorepo: all eight packages share one version and move
  together (policy in `docs/release.md`).
- Gated release workflow (`release.yml`, `workflow_dispatch`-only): validate
  job runs every repository gate plus pack and rehearsal audits; the publish
  job requires `main`, `dry_run=false`, an exact version confirmation, and
  the protected `npm-release` environment. Publishing authenticates through
  npm Trusted Publishing (OIDC) with provenance — no npm token exists.
- Pack validation (`pnpm test:pack`) and release rehearsal
  (`pnpm release:rehearsal`) audit every tarball, the workflow's security
  boundaries, and the version policy before anything reaches the registry.

### Breaking changes

None — initial release.
