/**
 * Capabilities reported by a renderer implementation.
 */
export interface RendererCapabilities {
  /**
   * Stable identifier of the renderer implementation, e.g. `"pixi"`.
   * Used to select renderers and in diagnostics.
   */
  readonly id: string;
  /** Human-readable renderer name, e.g. `"PixiJS"`. */
  readonly displayName: string;
}

/**
 * Options passed to {@link Renderer.initialize}.
 */
export interface RendererInitOptions {
  /**
   * The canvas the renderer draws to.
   * The renderer does not take ownership of the canvas: disposing the
   * renderer must not remove it from the DOM.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * Logical resolution width in pixels: the coordinate space game code
   * positions content in (the stage space). Optional; when omitted the
   * renderer uses its own default logical size. If provided, `height` must
   * be provided too; renderers reject mixed, non-finite, zero, or negative
   * values with {@link RendererError}.
   */
  readonly width?: number;
  /**
   * Logical resolution height in pixels. See {@link RendererInitOptions.width}
   * for the full semantics.
   */
  readonly height?: number;
  /** Background clear color as a CSS color string, e.g. `"#1099bb"`. */
  readonly backgroundColor?: string;
  /**
   * Rendering resolution (device pixel ratio).
   * When omitted, the renderer uses its own default.
   */
  readonly resolution?: number;
}

/**
 * The renderer-agnostic contract every g2w renderer implements.
 *
 * `@g2w/core` defines this contract and never imports a concrete renderer.
 * Renderer packages such as `@g2w/renderer-pixi` implement it on top of a
 * rendering technology.
 */
export interface Renderer {
  /** Identity and capabilities of this renderer. */
  readonly capabilities: RendererCapabilities;
  /** Whether the renderer is initialized and currently owns rendering resources. */
  readonly initialized: boolean;
  /**
   * Initialize the renderer against the given canvas.
   * Rejects with {@link RendererError} if the renderer is already initialized.
   */
  initialize(options: RendererInitOptions): Promise<void>;
  /**
   * Release all rendering resources owned by the renderer.
   * Rejects with {@link RendererError} if the renderer is not initialized.
   */
  dispose(): Promise<void>;
  /**
   * Render the current frame. Optional: renderers that drive their own
   * rendering (or cannot render on demand) may omit it. The game loop calls
   * this once per frame after the update callback, when present.
   */
  render?(): void;
  /**
   * Change the logical resolution at runtime. Optional: renderers with a
   * fixed output may omit it. The arguments follow the same rules as
   * {@link RendererInitOptions.width}/`height`: both are required and must
   * be finite and greater than zero, otherwise the renderer throws
   * {@link RendererError}. Resizing changes only the logical coordinate
   * space and the drawing buffer — it must never destroy textures or other
   * assets (see the renderer's ownership policy).
   */
  resize?(width: number, height: number): void;
}
