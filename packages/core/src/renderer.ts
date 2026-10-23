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
}
