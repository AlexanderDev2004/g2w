import { type Renderer, RendererError, type RendererInitOptions } from "@g2w/core";
import { describe, expect, it } from "vitest";

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
    if (!options.canvas) {
      throw new RendererError("FakeRenderer requires a canvas.");
    }
    this.#initialized = true;
  }

  async dispose(): Promise<void> {
    if (!this.#initialized) {
      throw new RendererError("FakeRenderer is not initialized.");
    }
    this.#initialized = false;
  }
}

const canvas = { width: 0, height: 0 } as HTMLCanvasElement;

describe("renderer contract", () => {
  it("can be implemented without any rendering technology", async () => {
    const renderer: Renderer = new FakeRenderer();

    expect(renderer.capabilities.id).toBe("fake");
    expect(renderer.initialized).toBe(false);

    await renderer.initialize({ canvas, backgroundColor: "#1099bb" });
    expect(renderer.initialized).toBe(true);

    await renderer.dispose();
    expect(renderer.initialized).toBe(false);
  });

  it("rejects double initialization with a RendererError", async () => {
    const renderer: Renderer = new FakeRenderer();
    await renderer.initialize({ canvas });

    await expect(renderer.initialize({ canvas })).rejects.toThrow(RendererError);
  });

  it("rejects disposal of an uninitialized renderer with a RendererError", async () => {
    const renderer: Renderer = new FakeRenderer();

    await expect(renderer.dispose()).rejects.toThrow(RendererError);
  });
});
