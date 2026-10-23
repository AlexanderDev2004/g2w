# hello-world example

A foundation-level example of the g2w renderer contract. `src/main.ts` implements a `FakeRenderer` against `@g2w/core`'s `Renderer` interface, initializes it against a canvas, and disposes it — no rendering technology involved.

This example is intentionally honest about the current stage: g2w's PixiJS adapter initializes a real PixiJS `Application`, but there is no build pipeline or starter for browser demos yet, so a runnable in-browser demo that actually draws will arrive with MVP 1.

The example is type-checked as part of the workspace: run `pnpm typecheck` from the repository root.
