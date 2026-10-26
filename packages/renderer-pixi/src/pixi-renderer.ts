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
 * Lifecycle: `initialize()` coalesces concurrent calls onto one in-flight
 * initialization, so the renderer never creates more than one `Application`.
 * A failed initialization rolls back — the partially initialized application
 * is destroyed best-effort — and rethrows the original error; a cleanup
 * failure is aggregated (`AggregateError`) instead of masking it, and the
 * renderer returns to a state where initialization can be retried.
 * `dispose()` destroys the application synchronously when nothing is in
 * flight (so a fire-and-forget `dispose(); init()` sequence keeps working),
 * and waits for a pending initialization before destroying it; concurrent
 * and repeated calls share one disposal, and a completed disposal rejects
 * further `dispose()` calls like any other uninitialized state. After a
 * completed disposal the renderer can be initialized again.
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

  /**
   * The application, assigned only once its `init()` has resolved — so
   * `initialized` stays false while initialization is pending and every
   * accessor keeps rejecting with the uninitialized contract.
   */
  #application: PixiApplicationLike | null = null;
  readonly #createApplication: () => PixiApplicationLike;

  /**
   * `initializing` and the in-flight wait of a deferred disposal carry their
   * work in these promises; every other state transition is synchronous.
   * `#disposePromise` is non-null only while a deferred disposal (one that
   * had to wait for a pending initialization) is still running.
   */
  #lifecycle: "new" | "initializing" | "initialized" = "new";
  #initPromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;

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

  /**
   * Create and initialize the PixiJS `Application`. Concurrent calls share
   * one in-flight initialization — the renderer is never initialized twice
   * and never owns more than one Application. On failure the partially
   * initialized application is destroyed (best-effort) and the original
   * error is rethrown; a rollback failure is aggregated with it instead of
   * masking it. After a failure the renderer may be initialized again.
   *
   * Rejects with {@link RendererError} while a deferred disposal is still
   * running — await `dispose()` before initializing again.
   */
  initialize(options: RendererInitOptions): Promise<void> {
    // Checked before the coalescing guard: if a deferred disposal has
    // started while initialization is pending, joining the pending init
    // would hand the caller a promise that resolves even though the
    // disposal is about to destroy the application.
    if (this.#disposePromise !== null) {
      return Promise.reject(
        new RendererError("PixiRenderer is disposing; await dispose() before initializing again."),
      );
    }
    if (this.#lifecycle === "initializing" && this.#initPromise !== null) {
      return this.#initPromise;
    }
    if (this.#lifecycle === "initialized") {
      return Promise.reject(
        new RendererError(
          "PixiRenderer is already initialized. Call dispose() before initializing it again.",
        ),
      );
    }

    // Logical resolution: both dimensions or neither, finite and > 0. When
    // omitted, PixiJS's own default (800×600) applies — the pre-R3 behavior.
    if ((options.width === undefined) !== (options.height === undefined)) {
      return Promise.reject(
        new RendererError("PixiRenderer requires both width and height, or neither."),
      );
    }
    if (
      (options.width !== undefined && (!Number.isFinite(options.width) || options.width <= 0)) ||
      (options.height !== undefined && (!Number.isFinite(options.height) || options.height <= 0))
    ) {
      return Promise.reject(
        new RendererError("width and height must be finite numbers greater than zero."),
      );
    }

    this.#lifecycle = "initializing";
    this.#initPromise = this.#initialize(options);
    return this.#initPromise;
  }

  async #initialize(options: RendererInitOptions): Promise<void> {
    // Creation failure needs the same reset as init failure: the lifecycle
    // is already "initializing" and #initPromise holds this rejection, so
    // without the reset later calls would coalesce onto it forever.
    let application: PixiApplicationLike;
    try {
      application = this.#createApplication();
    } catch (error) {
      this.#resetAfterFailedInit();
      throw error;
    }
    try {
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
    } catch (error) {
      // Roll back whatever the partial initialization acquired. A cleanup
      // failure must not mask the original error — both stay observable.
      try {
        this.#destroyApplication(application);
      } catch (cleanupError) {
        this.#resetAfterFailedInit();
        throw new AggregateError(
          [error, cleanupError],
          "PixiRenderer initialization failed and rollback cleanup failed.",
        );
      }
      this.#resetAfterFailedInit();
      throw error;
    }
    this.#application = application;
    this.#initPromise = null;
    this.#lifecycle = "initialized";
  }

  #resetAfterFailedInit(): void {
    this.#initPromise = null;
    this.#lifecycle = "new";
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

  /**
   * Destroy the application and release everything the renderer owns: stage
   * display objects, but never a texture or texture source (R1 — see the
   * class ownership note). The caller-provided canvas stays in the DOM.
   *
   * Disposing a renderer that is not initialized (never initialized, a
   * failed initialization, or already disposed) rejects with
   * {@link RendererError}. When initialization is pending, disposal waits
   * for it to settle first: a successful initialization is then destroyed,
   * and a failed one is not a disposal failure because its rollback already
   * released the partial application. Calls made while such a deferred
   * disposal is running share its promise.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    const pendingInit = this.#initPromise;
    if (this.#lifecycle === "initializing" && pendingInit !== null) {
      this.#disposePromise = this.#disposeAfterInit(pendingInit);
      return this.#disposePromise;
    }
    if (this.#lifecycle !== "initialized" || this.#application === null) {
      return Promise.reject(new RendererError("PixiRenderer is not initialized."));
    }
    // Nothing is in flight: destroy synchronously so the historical
    // fire-and-forget `dispose(); init()` sequence keeps working, and so a
    // repeated call deterministically rejects on the uninitialized contract.
    const application = this.#application;
    this.#application = null;
    this.#lifecycle = "new";
    try {
      this.#destroyApplication(application);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  async #disposeAfterInit(pendingInit: Promise<void>): Promise<void> {
    try {
      try {
        await pendingInit;
      } catch (error) {
        // A plain initialization failure is not a disposal failure: its
        // rollback already released the partial application. A rollback
        // cleanup failure (AggregateError) may have left partial resources
        // behind — surface it to the disposal caller instead of hiding it.
        if (error instanceof AggregateError) {
          throw error;
        }
      }
      const application = this.#application;
      this.#application = null;
      if (application !== null) {
        this.#destroyApplication(application);
      }
    } finally {
      this.#lifecycle = "new";
      this.#initPromise = null;
      this.#disposePromise = null;
    }
  }

  #destroyApplication(application: PixiApplicationLike): void {
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
