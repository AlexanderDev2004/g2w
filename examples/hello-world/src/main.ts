import { type Renderer, RendererError, type RendererInitOptions } from "@g2w/core";

/**
 * A fake renderer that satisfies the core contract without any rendering
 * technology. It logs lifecycle events instead of drawing anything.
 */
class FakeRenderer implements Renderer {
  readonly capabilities = { id: "fake", displayName: "Fake" } as const;

  #initialized = false;

  get initialized(): boolean {
    return this.#initialized;
  }

  async initialize(options: RendererInitOptions): Promise<void> {
    if (this.#initialized) {
      throw new RendererError("FakeRenderer is already initialized.");
    }
    console.log(
      `[FakeRenderer] initializing on canvas ${options.canvas.width}x${options.canvas.height}`,
      `with background ${options.backgroundColor ?? "(default)"}`,
    );
    this.#initialized = true;
  }

  async dispose(): Promise<void> {
    if (!this.#initialized) {
      throw new RendererError("FakeRenderer is not initialized.");
    }
    console.log("[FakeRenderer] disposed");
    this.#initialized = false;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (canvas === null) {
  throw new RendererError("Canvas #game not found in the document.");
}

const renderer: Renderer = new FakeRenderer();
await renderer.initialize({ canvas, backgroundColor: "#1099bb" });
console.log(`${renderer.capabilities.displayName} ready: initialized=${renderer.initialized}`);
await renderer.dispose();
