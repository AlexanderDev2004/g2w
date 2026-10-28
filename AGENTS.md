# AGENTS.md

Guidance for AI coding agents (Amp and others) working in this repository.

## Project

**g2w (Game to Website)** is a TypeScript-first, AI-agent-ready framework for building and shipping web games. 2D first with PixiJS; 3D via a future Three.js adapter. The repository is at **R5 + E3 + E4 + R6-1 + R6-2 + R6-3 + R7 — gamepad/touch input, failure-safe adapter lifecycles, Effect as the primary application runtime, renderer backend selection/reporting, a shared renderer conformance suite, browser-verified rendering backends including per-backend feature verification, and the create-g2w starter CLI**: monorepo, renderer contract, `Game` lifecycle and frame loop, renderer-agnostic `SceneManager`, DOM-free `InputState` (keyboard, pointer, multi-touch) with the `@g2w/input-dom` browser adapter, DOM-free `GamepadState` with the `@g2w/input-gamepad` Gamepad API adapter, a generic `AssetManager` in core with the `@g2w/renderer-pixi` texture loader, the `Transform2D`/`Sprite2D` model in core with the adapter's `createSpriteView`, the minimal `GameObject`/`GameObjectCollection` layer in core, the `@g2w/devtools` read-only overlay, a renderer-agnostic `AudioManager` in core with the `@g2w/audio-web` Web Audio backend, the Effect-based `@g2w/runtime` foundation (E1 bootstrap + E2 Effect-native `G2WGame` lifecycle; core `Game` unchanged) — with the browser demo booting through `G2WGame` as of E4 — PixiJS adapter, the `create-g2w` project-scaffolding CLI (R7), a Vite browser demo, tests, CI, and docs. R6-1 adds an optional renderer backend preference (`RendererInitOptions.backend`, forwarded to PixiJS `preference`) and actual-backend reporting (`RendererCapabilities.backend`, from PixiJS's public `renderer.name`); core stays dependency-free. R6-2 adds the shared renderer conformance suite (`packages/core/test/renderer-conformance.ts`, defined against the `Renderer` interface only) that renderer adapters adopt with deterministic fakes, and the backend smoke harness (`node scripts/smoke-renderer-backends.mjs`, browser-dependent, not part of `pnpm test`). R6-3 adds the per-backend feature smoke (`node scripts/smoke-renderer-features.mjs`, same CDP harness pattern, objective pixel assertions; browser-dependent, not part of `pnpm test`).

## Architecture boundaries

- `@g2w/core` (packages/core) owns the renderer-agnostic contract, the `Game` runtime, the `SceneManager`, the DOM-free `InputState` and `GamepadState`, the generic `AssetManager`, the `Transform2D`/`Sprite2D` model, the `GameObject`/`GameObjectCollection` layer, and the `AudioManager` audio contract. It must never import a rendering technology or touch browser globals/DOM events at runtime, and must keep zero runtime dependencies.
- `@g2w/renderer-pixi` (packages/renderer-pixi) implements the renderer contract on top of PixiJS and adapts texture loading (`createTextureAssetManager`) and sprite rendering (`createSpriteView`) to the core model. It may depend on `@g2w/core` and PixiJS. The dependency must never point the other way.
- `@g2w/input-dom` (packages/input-dom) adapts real browser events onto the core `InputState` (keyboard, pointer, and touch contacts through Pointer Events). It may depend on `@g2w/core` only; all DOM event handling lives here, never in core.
- `@g2w/input-gamepad` (packages/input-gamepad) samples gamepads onto the core `GamepadState` through the Gamepad API with an injectable polling source; the host drives sampling with `poll()`. It may depend on `@g2w/core` only; all Gamepad API and browser event handling lives here, never in core.
- `@g2w/audio-web` (packages/audio-web) implements the core audio backend contract on top of the Web Audio API: it decodes sound files, starts playbacks, and owns the `AudioContext` lifecycle. It may depend on `@g2w/core` only; all browser audio handling lives here, never in core.
- `@g2w/devtools` (packages/devtools) renders a read-only runtime overlay on top of core state. It may depend on `@g2w/core` only; it observes through immutable snapshots and never mutates or disposes the runtime.
- `@g2w/runtime` (packages/runtime) is the Effect-based bootstrap foundation (E1) plus the Effect-native game lifecycle (E2): one managed Effect runtime, explicit idempotent shutdown, best-effort finalizer cleanup with observable failures, and `G2WGame` — the core `Game` state machine and frame-loop contract orchestrated through the managed runtime (renderer init as a lifecycle effect, ownership as LIFO finalizers, idempotent disposal). It may depend on `@g2w/core` and `effect` (exact-pinned); `@g2w/core` must never depend on Effect or import it. The frame hot path never allocates an Effect runtime, effect, or promise. As of E4, the hello-world demo boots through `G2WGame` (the primary application path); core `Game` remains the reference implementation. E3 lifecycle hardening is complete for `@g2w/renderer-pixi`, `@g2w/input-dom`, and `@g2w/input-gamepad`; these adapters remain imperative (no per-adapter Effect runtime). Audio/asset adapter migration remains out of scope.
- `create-g2w` (packages/create-g2w) is a zero-dependency Node CLI (Node >= 22) that scaffolds a new game project from its bundled `template/` directory. It is a developer tool, not a runtime package: it imports nothing from g2w, never prompts, and its only subprocess is a local `git init` in the freshly generated directory (skipped with a warning when Git is missing or the destination already has Git metadata; never a remote, an initial commit, or a push) — Git runs through an explicit argv array, never a shell string, and its template uses only public `@g2w/*` entry points. Template dependency versions are pinned; the `@g2w/*` packages are consumed at `0.1.0` (published to npm as of 2026-10-28) and are additionally validated through packed tarballs (`node scripts/smoke-create-g2w.mjs`, manual, browser-dependent, not part of `pnpm test`).
- `examples/hello-world` consumes only the public exports of the workspace packages through Vite; it must not bypass g2w by creating a PixiJS `Application` directly.
- Tests in `packages/core/test/architecture.test.ts`, `packages/core/test/game.test.ts`, `packages/core/test/scene-manager.test.ts`, `packages/core/test/input.test.ts`, `packages/core/test/gamepad.test.ts`, `packages/core/test/asset-manager.test.ts`, `packages/core/test/game-object.test.ts`, `packages/core/test/audio-manager.test.ts`, `packages/input-dom/test/`, `packages/input-gamepad/test/`, `packages/renderer-pixi/test/`, `packages/audio-web/test/`, `packages/devtools/test/`, `packages/runtime/test/`, and `packages/create-g2w/test/` enforce these boundaries — keep them passing and extend them when adding packages.

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
- `pnpm test:pack` — R10 Phase 1 packability validation (`scripts/validate-packages.mjs`, manual): builds, packs all eight intended publishable packages into a temp dir outside the workspace, audits every tarball (manifest fields point at archived files, no unresolved `workspace:*`, no dev files or secrets, dependency versions consistent, release metadata present), then installs the tarballs into a throwaway TypeScript + Vite consumer project outside the monorepo and typechecks/builds against the public entry points, and runs the packed `create-g2w` CLI from that consumer. It publishes nothing and is deliberately not in CI: fresh installs of Vite/TypeScript make it slower and network-dependent than the fast validate job.
- `pnpm release:rehearsal` — R10 Phase 2 release rehearsal (`scripts/release-rehearsal.mjs`, manual): runs `test:pack`, audits version consistency across the eight manifests and the create-g2w template pin, audits release metadata, runs `npm pack --dry-run` per package, and prints the deterministic release plan. Never publishes, never creates tags, needs no npm token; registry-side facts (name availability, ownership, Trusted Publisher setup) are reported as external prerequisites. The release policy, checklist, and recovery procedure live in `docs/release.md`; publishing itself is only possible through the manual `release.yml` workflow dispatch behind its explicit gates.

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
- Gamepad tests must stay deterministic: inject polling sources, fake `PolledGamepad` objects, and fake connection `EventTarget`s into `GamepadState`/`GamepadInput`, never real hardware, timers, or a browser.
- Asset tests must stay deterministic: inject loaders (deferred promises and fake assets) into `AssetManager`/`createTextureAssetManager`, never real timers, network, or a browser.
- Audio tests must stay deterministic: inject backends, fake `Sound`/`SoundPlayback` objects, and fake `AudioContext`/`fetch` into `AudioManager`/`WebAudioBackend`, never real timers, audio devices, or a browser.
- Game-object tests must stay deterministic: drive collections directly with plain objects and injected transforms, never real timers or a browser.
- DevTools tests must stay deterministic: drive the overlay with an injected fake DOM document and an injected scheduler, never real timers or a browser.
- Runtime tests must stay deterministic: drive the Effect facade with real bootstrap/shutdown calls (pure microtask async, no timers) and plain finalizer callbacks, never real schedulers or a browser.
- Renderer-agnostic renderer-contract behavior must run through the shared conformance suite (`packages/core/test/renderer-conformance.ts`) with a deterministic gated fake of the adapter's backing implementation, never real rendering technology or a browser; technology-specific behavior (texture ownership, option forwarding, destroy arguments) stays in the adapter's own test files. Browser backend verification lives in `scripts/smoke-renderer-backends.mjs` and per-backend feature verification (R6-3) in `scripts/smoke-renderer-features.mjs`, run manually with a locally installed Chrome, never in `pnpm test`.
- No new dependencies without a clear need. `@g2w/core` stays dependency-free.
- Do not enable `skipLibCheck: false`-style weakening or suppress type errors; fix the underlying issue.
- Biome owns formatting (2-space indent, 100-char lines) — run `pnpm format` rather than hand-formatting.

## Scope discipline

- Do not expand beyond the current MVP scope without explicit approval. Out of scope as of E2 (Effect-native game lifecycle): migrating `SceneManager`/`AssetManager` execution or any input/renderer/audio adapter onto the Effect runtime, replacing core `Game` (both runtimes ship side by side), key/button remapping, action mapping or rebinding, haptics/vibration, input recording, scene stacks, transition effects, scene persistence, ECS components or scene graphs, audio mixers/spatial audio/adaptive music/streaming, sprite batching helpers, texture atlases, manifest-based bulk loading, physics, animations, cameras, integrations (React/Vue/Next.js), multiplayer, MCP servers, 3D runtime, npm publishing, release automation.
- Document planned-but-unimplemented features as roadmap items in the README or docs, never as stubs or placeholder code.

## Definition of done

A change is done when:
1. It implements the requested behavior and nothing more.
2. `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm verify:exports`, and `pnpm test` all pass.
3. Documentation touched by the change (README, docs/architecture.md, this file) still matches the implementation, including every documented command.
4. The diff contains no unrelated changes, no leftover dead code, and no untracked build artifacts (`dist/`, `*.tsbuildinfo` are gitignored).
