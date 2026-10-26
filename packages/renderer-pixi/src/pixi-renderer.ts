import {
  type Renderer,
  type RendererCapabilities,
  RendererError,
  type RendererInitOptions,
} from "@g2w/core";
import {
  Application,
  type ApplicationOptions,
  type Container,
  type DestroyOptions,
  type RendererDestroyOptions,
} from "pixi.js";

/**
 * The subset of the PixiJS `Application` API the adapter uses. Injectable so
 * tests (and alternative application hosts) can substitute their own instance;
 * production code omits the injection and gets a real `Application`.
 */
export interface PixiApplicationLike {
  init(options?: Partial<ApplicationOptions>): Promise<void>;
  render(): void;
  destroy(rendererDestroyOptions?: RendererDestroyOptions, options?: DestroyOptions): void;
  readonly stage: Container;
  /**
   * The PixiJS renderer system. `resize(width, height)` changes the logical
   * resolution and the drawing buffer; with `autoDensity` it also updates
   * the canvas's CSS size. It never touches textures.
   */
  readonly renderer: { resize(width: number, height: number): void };
}

/** Options for constructing a {@link PixiRenderer}. */
export interface PixiRendererOptions {
  /**
   * Creates the underlying PixiJS `Application`. Defaults to
   * `() => new Application()`. Injectable so tests can substitute a fake
   * without a browser or GPU; production code should omit it.
   */
  readonly createApplication?: () => PixiApplicationLike;
}

/**
 * g2w renderer adapter built on PixiJS.
 *
 * Implements the renderer-agnostic contract from `@g2w/core` on top of a
 * PixiJS `Application`. Initialization is asynchronous, matching the PixiJS
 * v8 lifecycle, and disposes leave a caller-provided canvas in the DOM.
 *
 * PixiJS's own ticker render loop is disabled (`autoStart: false`); the game
 * loop from `@g2w/core` drives rendering through {@linkcode PixiRenderer.render}.
 * The stage is exposed so applications can add content without a broader
 * scene API — this is a provisional, minimal capability.
 *
 * Ownership — the renderer owns **display objects, never textures**: disposal
 * destroys the display objects still attached to the stage, but no texture or
 * texture source. Stage-attached textures typically come from PixiJS's shared
 * `Assets` cache (see `createTextureAssetManager`) and may be referenced by
 * other managers, sprites, or subsystems, so the renderer cannot prove
 * exclusive ownership and must not destroy them. Texture lifetime is governed
 * by the asset policy: shared-cache textures live until the page unloads, and
 * an application that knows nothing else uses a texture may unload it
 * explicitly with `Assets.unload(url)`.
 */
export class PixiRenderer implements Renderer {
  readonly capabilities: RendererCapabilities = {
    id: "pixi",
    displayName: "PixiJS",
  };

  #application: PixiApplicationLike | null = null;
  readonly #createApplication: () => PixiApplicationLike;

  constructor(options: PixiRendererOptions = {}) {
    this.#createApplication = options.createApplication ?? (() => new Application());
  }

  get initialized(): boolean {
    return this.#application !== null;
  }

  /**
   * The root display container. Rejects with {@link RendererError} before
   * initialization.
   */
  get stage(): Container {
    const application = this.#application;
    if (application === null) {
      throw new RendererError("PixiRenderer is not initialized.");
    }
    return application.stage;
  }

  async initialize(options: RendererInitOptions): Promise<void> {
    if (this.#application !== null) {
      throw new RendererError(
        "PixiRenderer is already initialized. Call dispose() before initializing it again.",
      );
    }

    // Logical resolution: both dimensions or neither, finite and > 0. When
    // omitted, PixiJS's own default (800×600) applies — the pre-R3 behavior.
    if ((options.width === undefined) !== (options.height === undefined)) {
      throw new RendererError("PixiRenderer requires both width and height, or neither.");
    }
    if (
      (options.width !== undefined && (!Number.isFinite(options.width) || options.width <= 0)) ||
      (options.height !== undefined && (!Number.isFinite(options.height) || options.height <= 0))
    ) {
      throw new RendererError("width and height must be finite numbers greater than zero.");
    }

    const application = this.#createApplication();
    await application.init({
      canvas: options.canvas,
      autoDensity: true,
      autoStart: false,
      ...(options.width === undefined || options.height === undefined
        ? {}
        : { width: options.width, height: options.height }),
      ...(options.backgroundColor === undefined
        ? {}
        : { backgroundColor: options.backgroundColor }),
      ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    });

    this.#application = application;
  }

  /**
   * Change the logical resolution at runtime. With `autoDensity`, PixiJS
   * updates both the drawing buffer (`width × height × resolution`) and the
   * canvas's CSS size; the stage coordinate space becomes exactly
   * `width × height`. Textures and texture sources are never touched.
   * Throws {@link RendererError} before initialization or for invalid
   * dimensions.
   */
  resize(width: number, height: number): void {
    const application = this.#application;
    if (application === null) {
      throw new RendererError("PixiRenderer is not initialized.");
    }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new RendererError("width and height must be finite numbers greater than zero.");
    }
    application.renderer.resize(width, height);
  }

  /**
   * Render the current stage to the canvas. Rejects with
   * {@link RendererError} if the renderer is not initialized.
   */
  render(): void {
    const application = this.#application;
    if (application === null) {
      throw new RendererError("PixiRenderer is not initialized.");
    }
    application.render();
  }

  async dispose(): Promise<void> {
    const application = this.#application;
    if (application === null) {
      throw new RendererError("PixiRenderer is not initialized.");
    }

    this.#application = null;
    // removeView: false keeps the caller-provided canvas in the DOM.
    // children: true destroys the display objects the stage still holds; the
    // renderer owns stage content. The texture and textureSource flags are
    // deliberately NOT set (R1): stage-attached textures come from PixiJS's
    // shared `Assets` cache (see createTextureAssetManager) and may still be
    // referenced by other managers, sprites, or subsystems, so destroying
    // them here could invalidate resources the renderer does not own.
    application.destroy({ removeView: false }, { children: true });
  }
}
