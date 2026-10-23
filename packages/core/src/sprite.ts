/** Options accepted by the {@link Transform2D} constructor. */
export interface Transform2DInit {
  /** Position on the x axis, in the renderer's logical pixels. Default `0`. */
  readonly x?: number;
  /** Position on the y axis, in the renderer's logical pixels. Default `0`. */
  readonly y?: number;
  /** Rotation in **radians**. Default `0`. */
  readonly rotation?: number;
  /** Horizontal scale; `1` means natural scale. Default `1`. */
  readonly scaleX?: number;
  /** Vertical scale; `1` means natural scale. Default `1`. */
  readonly scaleY?: number;
}

/**
 * A mutable, renderer-independent 2D transform: position, rotation, and
 * scale. Units and defaults:
 * - `x`/`y` are logical pixel positions (default `0`).
 * - `rotation` is in **radians** (default `0`); its direction convention is
 *   the renderer's screen space (for PixiJS: positive values rotate
 *   clockwise, because the y axis points down).
 * - `scaleX`/`scaleY` are multipliers where `1` means natural scale
 *   (default `1`).
 *
 * Properties are plain mutable numbers; gameplay code mutates them and the
 * renderer adapter picks the changes up through an explicit `sync()` call —
 * there are no observers, proxies, or per-frame subscriptions.
 */
export class Transform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;

  constructor(init: Transform2DInit = {}) {
    this.x = init.x ?? 0;
    this.y = init.y ?? 0;
    this.rotation = init.rotation ?? 0;
    this.scaleX = init.scaleX ?? 1;
    this.scaleY = init.scaleY ?? 1;
  }
}

/** Options accepted by the {@link Sprite2D} constructor. */
export interface Sprite2DInit<TTexture> {
  /** The texture this sprite renders. Typed by the caller; core never inspects it. */
  readonly texture: TTexture;
  /**
   * The transform to use. When omitted, a fresh {@link Transform2D} with
   * default values is created. When supplied, the sprite shares the caller's
   * instance, so several sprites can be driven by one transform.
   */
  readonly transform?: Transform2D;
  /** Whether the sprite is rendered. Default `true`. */
  readonly visible?: boolean;
  /** Opacity from `0` (transparent) to `1` (opaque). Default `1`. */
  readonly alpha?: number;
}

/**
 * A minimal, renderer-independent sprite model: a typed texture reference, a
 * {@link Transform2D}, and the visual properties the current demos need
 * (`visible`, `alpha`). Core never inspects or destroys the texture — it is a
 * generic `TTexture` handle supplied by the caller (typically from a
 * renderer's asset API).
 *
 * The model is plain mutable data. A renderer adapter turns it into a display
 * object and applies changes through an explicit `sync()` call (see
 * `createSpriteView` in `@g2w/renderer-pixi`); mutating the model alone never
 * touches the renderer.
 *
 * Intentionally unsupported: parent/child hierarchies, anchors/pivots,
 * z-ordering, tint, blend modes, animation timelines, and entity components.
 */
export class Sprite2D<TTexture> {
  /** The texture handle this sprite renders. */
  readonly texture: TTexture;
  /** Position, rotation, and scale of the sprite. */
  readonly transform: Transform2D;
  /** Whether the sprite is rendered. */
  visible: boolean;
  /** Opacity from `0` (transparent) to `1` (opaque). */
  alpha: number;

  constructor(init: Sprite2DInit<TTexture>) {
    this.texture = init.texture;
    this.transform = init.transform ?? new Transform2D();
    this.visible = init.visible ?? true;
    this.alpha = init.alpha ?? 1;
  }
}
