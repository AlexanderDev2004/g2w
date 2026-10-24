# Architecture

This document describes the **actual implemented architecture** of g2w as of MVP 1F. Every claim here is backed by source under [packages/](packages) and enforced by tests; the in-depth narrative lives in [docs/architecture.md](docs/architecture.md).

## 1. Architectural goals

1. **Renderer-agnostic core.** [`@g2w/core`](packages/core/src) contains all framework concepts and has **zero runtime dependencies** and no rendering-technology or browser-DOM imports. Architecture tests in [packages/core/test/architecture.test.ts](packages/core/test/architecture.test.ts) enforce this.
2. **Small explicit public APIs.** Each package exports exactly what it documents ([packages/core/src/index.ts](packages/core/src/index.ts), [packages/renderer-pixi/src/index.ts](packages/renderer-pixi/src/index.ts), [packages/input-dom/src/index.ts](packages/input-dom/src/index.ts)); export integrity is verified after every build by [scripts/verify-exports.mjs](scripts/verify-exports.mjs).
3. **Explicit resource ownership.** Every texture, display object, event listener, and loop has one documented owner and a tested disposal path.
4. **Deterministic tests.** All core tests run in plain Node — injectable schedulers, fake loaders, fake event targets; no browser, GPU, or sleeps.

## 2. Workspace and package map

pnpm workspace (see [pnpm-workspace.yaml](pnpm-workspace.yaml)):

| Package                    | Path                                                          | Role                                                                             |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@g2w/core`                | [packages/core](packages/core/package.json)                   | Renderer-agnostic contracts and runtime (zero runtime dependencies)              |
| `@g2w/renderer-pixi`       | [packages/renderer-pixi](packages/renderer-pixi/package.json) | PixiJS 8 implementation of the renderer contract + texture loader + sprite views |
| `@g2w/input-dom`           | [packages/input-dom](packages/input-dom/package.json)         | Browser event adapter feeding core `InputState`                                  |
| `@g2w/example-hello-world` | [examples/hello-world](examples/hello-world/package.json)     | Vite browser demo consuming only public package exports                          |

## 3. Dependency direction

```text
┌─────────────────────┐
│      @g2w/core      │  zero runtime dependencies
└─────────────────────┘
   ▲                 ▲
   │                 │
┌────────────────┐  ┌──────────────┐
│@g2w/renderer-  │  │@g2w/input-dom│
│pixi (+pixi.js) │  │ (browser API)│
└────────────────┘  └──────────────┘
   ▲
   │
┌──────────────────────────────┐
│ @g2w/example-hello-world     │
│ (core + both adapters + Vite)│
└──────────────────────────────┘
```

Adapters depend on core (`"workspace:*"`); core depends on nothing. PixiJS is a **peer dependency** of `@g2w/renderer-pixi` (`>=8`) pinned as an exact dev dependency (`8.22.0`) — the application supplies the implementation. No arrow in this graph ever points into core from a renderer concept; [docs/architecture.md](docs/architecture.md) documents this as the primary architectural rule.

## 4. Core and renderer boundary

- Core defines the [`Renderer` contract](packages/core/src/renderer.ts): `initialize(options)`, optional `render()`, `dispose()`, `initialized`, `capabilities`, and a `stage` typed as an opaque `Container`-like value the core never manipulates.
- Core never imports PixiJS, DOM types, or any UI framework. The type parameterization keeps generic models (e.g. `Sprite2D<TTexture>`) renderer-free.
- All PixiJS imports live in [`packages/renderer-pixi/src`](packages/renderer-pixi/src); all DOM event handling lives in [`packages/input-dom/src`](packages/input-dom/src).

## 5. Runtime lifecycle

[`Game`](packages/core/src/game.ts) owns exactly one renderer and one frame loop:

```text
new ──init()──► initializing ──ok──► initialized ──start()──► running
      │                                        ▲                │
      │ init failure: rethrow, returns to new  │ start()  stop()│
      ▼                                        └──── stopped ◄──┘
                any state ──dispose()──► disposed (terminal, idempotent)
```

- `init()` initializes the renderer once (concurrent calls share one promise); `start()` only from `initialized`/`stopped`; `stop()` cancels the pending frame; `dispose()` is terminal.
- Each frame: the scheduler callback computes a **clamped seconds-based `deltaTime`** (max `maxDeltaTime`, default 0.25 s), invokes `onUpdate(deltaTime)`, then calls `renderer.render()`. There is exactly one loop — PixiJS's own ticker is disabled (`autoStart: false`, see [packages/renderer-pixi/src/pixi-renderer.ts](packages/renderer-pixi/src/pixi-renderer.ts)) — and the loop is backed by an injectable [`FrameScheduler`](packages/core/src/frame-scheduler.ts) (default `requestAnimationFrame`) so tests drive frames deterministically.

## 6. Scene and update-loop model

[`SceneManager`](packages/core/src/scene-manager.ts) (see [`Scene`](packages/core/src/scene.ts)) owns a fixed set of named scenes and updates only the active one; applications compose it with `Game` via `onUpdate`:

```ts
const game = new Game({
  renderer,
  canvas,
  onUpdate: (dt) => {
    scenes.update(dt);
    input.endFrame();
  },
});
```

- Hooks are optional and synchronous: `init()` (at most once per instance, lazily, retryable), `enter()`/`exit()` (paired per activation), `update(deltaTime)`, `dispose()`.
- Transitions exit the previous scene **before** entering the next; requests from inside a running hook are deferred to the next `update` (latest request wins); re-activating the active scene is a no-op.
- Hook errors propagate unwrapped with defined recovery (a failed init/enter leaves no active scene; a later `goTo` recovers).
- `dispose()` exits the active scene, disposes initialized scenes in registration order, is best-effort (single error rethrown, multiple as `AggregateError`), terminal, and idempotent.
- A scene instance belongs to exactly one manager for its lifetime — enforced by a claim registry at construction ([packages/core/src/scene-manager.ts](packages/core/src/scene-manager.ts)).

## 7. Input handling

- [`InputState`](packages/core/src/input.ts) is the DOM-free state machine: keyboard held/pressed/released edges, pointer position/buttons, focus-loss release. Edge states reset only at an explicit `endFrame()` boundary — placed **after every consumer** in the frame.
- [`DomInput`](packages/input-dom/src/index.ts) (`@g2w/input-dom`) subscribes to real events (keyboard on an injectable target, pointer on the canvas, `pointerup` on `window`, `blur`), normalizes pointer coordinates to canvas pixels accounting for CSS scaling, and never calls `preventDefault()`. `attach()` is idempotent; `dispose()` removes every registered listener; a disposed adapter cannot re-attach.

## 8. Renderer adapter contract

`@g2w/renderer-pixi` implements the core contract on top of a PixiJS `Application` ([packages/renderer-pixi/src/pixi-renderer.ts](packages/renderer-pixi/src/pixi-renderer.ts)):
- `initialize()` mirrors PixiJS v8's async `Application.init()`; the caller-provided canvas is kept on dispose (`removeView: false`).
- `autoStart: false` — rendering happens on demand through `render()` from the game loop.
- `stage` throws `RendererError` before initialization; `initialize()` twice throws rather than silently re-initializing.

## 9. PixiJS implementation notes

- [`createTextureAssetManager()`](packages/renderer-pixi/src/assets.ts) returns a core `AssetManager<Texture>` loading by URL through PixiJS's shared `Assets` cache.
- [`createSpriteView({ sprite, renderer })`](packages/renderer-pixi/src/sprite-view.ts) attaches one PixiJS `Sprite` to the stage for a core `Sprite2D` model; `sync()` applies position/rotation(radians)/scale/visibility/alpha; `dispose()` removes and destroys only its own display object, is idempotent, and never touches the texture, the stage, or siblings.
- Sprite views must be created after `game.init()` — the stage accessor requires an initialized renderer.

## 10. Asset loading, caching, and ownership

[`AssetManager`](packages/core/src/asset-manager.ts) (core): async loader injection, opaque string keys, promise-level caching, concurrent-request deduplication, retryable failures (a rejected load removes its cache entry), terminal idempotent disposal (single error rethrown, multiple as `AggregateError`).

Ownership is a constructor decision:
- **`disposeAsset` provided** — the manager owns its values and destroys each exactly once at disposal.
- **`disposeAsset` omitted** — values are caller-owned; disposal clears the cache without touching values.

`createTextureAssetManager()` deliberately omits `disposeAsset`: textures returned by PixiJS's shared `Assets` cache may be referenced by other managers or sprites, and PixiJS offers no supported exclusive-ownership mechanism (`Assets.unload` destroys regardless of other holders).

**Resource-lifecycle warning (open question R1 in [ROADMAP.md](ROADMAP.md)):** these two documented policies coexist:
1. _Asset policy:_ framework asset disposal never destroys shared-cache textures; they "live until the page unloads."
2. _Renderer implementation:_ `PixiRenderer.dispose()` calls `Application.destroy(..., { texture: true, textureSource: true })`, which **does** destroy every texture attached to the stage tree at that moment.

In the demo's teardown order (scenes → game → assets, [examples/hello-world/src/main.ts](examples/hello-world/src/main.ts)) stage-attached textures are therefore destroyed by the renderer, not reclaimed by the page unload. The two statements are each true of their own API, but the composed behavior contradicts the documented lifetime claim. This is recorded as an open decision (renderer stops destroying textures, or the docs state that renderer disposal ends texture lifetime for stage content); **no code change was made speculatively** — see [ROADMAP.md](ROADMAP.md) R1.

## 11. Error handling and disposal

Every package defines one narrow error class (`GameError`, `SceneError`, `RendererError`, `AssetError`, `DomInputError`, `SpriteViewError`); hook/loader errors are never wrapped — they propagate unchanged to the caller of the triggering method. Disposal everywhere is terminal and idempotent; multi-target cleanup (scene manager, asset manager) is best-effort with the first error rethrown and several failures aggregated as `AggregateError`.

## 12. Public API and exports

Entry points are the `exports` maps in each `package.json`; [scripts/verify-exports.mjs](scripts/verify-exports.mjs) imports every built package through its real entry point after `pnpm build` and exercises the main flows (renderer construction, asset pipeline with injected loader, sprite model → view → sync → dispose) to catch broken or undeclared exports. CI runs it on every push and PR.

## 13. Build and test architecture

- Build: `tsc -b` project references ([tsconfig.base.json](tsconfig.base.json): strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, NodeNext ESM).
- Type check: `tsc -p tsconfig.check.json --noEmit` across sources, tests, and examples.
- Lint/format: Biome ([biome.json](biome.json), 2-space, 100-char lines).
- Tests: Vitest, ~142 tests across 12 files, all deterministic and browser-free; the browser demo is validated by a manual/headless smoke run, not by the unit suite.
- CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — least-privilege `contents: read`, Actions pinned to verified commit SHAs, `pnpm install --frozen-lockfile` → check → typecheck → build → build:example → verify:exports → test. Dependabot keeps Actions and workspace dependencies updated (weekly).

## 14. Extension points and future adapters

- **New renderers** implement the core `Renderer` contract in a new package (peer-dependency pattern, as `@g2w/renderer-pixi` does). A Three.js adapter is exploratory — see [ROADMAP.md](ROADMAP.md) R8.
- **New input sources** implement adapter packages feeding `InputState` (the `DomInput` pattern).
- **New asset types** are new `create*AssetManager()` factories over the generic `AssetManager`.
- Scenes receive dependencies through plain composition — there is no service locator to extend.

## 15. Known limitations and open decisions

1. **Texture lifetime vs renderer disposal** — the open question documented in §10 and tracked as R1.
2. **No game-object layer yet** — games manage sprite arrays themselves; planned (R2).
3. **Sprites pivot at the texture's top-left**; anchors/pivots are planned (R3).
4. **Synchronous scene hooks only** — async lifecycle is intentionally unsupported to keep transitions deterministic.
5. **Packages are unpublished** — public APIs may still change without semver protection.
6. **Browser smoke testing is not automated in CI** — the demo is validated manually or via a headless session; CI covers packages only.
