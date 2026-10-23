import {
  type Renderer,
  type RendererCapabilities,
  RendererError,
  type RendererInitOptions,
} from "@g2w/core";
import { Application } from "pixi.js";

/**
 * g2w renderer adapter built on PixiJS.
 *
 * Implements the renderer-agnostic contract from `@g2w/core` on top of a
 * PixiJS `Application`. Initialization is asynchronous, matching the PixiJS
 * v8 lifecycle, and disposes leave a caller-provided canvas in the DOM.
 */
export class PixiRenderer implements Renderer {
  readonly capabilities: RendererCapabilities = {
    id: "pixi",
    displayName: "PixiJS",
  };

  #application: Application | null = null;

  get initialized(): boolean {
    return this.#application !== null;
  }

  async initialize(options: RendererInitOptions): Promise<void> {
    if (this.#application !== null) {
      throw new RendererError(
        "PixiRenderer is already initialized. Call dispose() before initializing it again.",
      );
    }

    const application = new Application();
    await application.init({
      canvas: options.canvas,
      autoDensity: true,
      ...(options.backgroundColor === undefined
        ? {}
        : { backgroundColor: options.backgroundColor }),
      ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    });

    this.#application = application;
  }

  async dispose(): Promise<void> {
    const application = this.#application;
    if (application === null) {
      throw new RendererError("PixiRenderer is not initialized.");
    }

    this.#application = null;
    // removeView: false keeps the caller-provided canvas in the DOM.
    application.destroy(
      { removeView: false },
      { children: true, texture: true, textureSource: true },
    );
  }
}
