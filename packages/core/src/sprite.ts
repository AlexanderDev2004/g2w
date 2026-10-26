import { SpriteError } from "./sprite-error.js";

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

/** Options accepted by the {@link Anchor2D} constructor. */
export interface Anchor2DInit {
  /**
   * Normalized horizontal anchor: `0` is the left edge, `0.5` the horizontal
   * center, `1` the right edge. Default `0`.
   */
  readonly x?: number;
  /**
   * Normalized vertical anchor: `0` is the top edge, `0.5` the vertical
   * center, `1` the bottom edge. Default `0`.
   */
  readonly y?: number;
}

/**
 * The normalized origin point a sprite's position, rotation, and scale are
 * relative to. `x`/`y` run from `0` (left/top edge) to `1` (right/bottom
 * edge); the default `(0, 0)` is the top-left corner, which preserves the
 * pre-anchor placement behavior.
 *
 * The anchor is normalized, so it is independent of the texture's pixel
 * size. A center anchor `(0.5, 0.5)` rotates the sprite around its center;
 * a feet anchor `(0.5, 1)` makes the position the sprite's bottom-center.
 *
 * The coordinates are read-only; the single mutation path is {@linkcode
 * Anchor2D.set}, which rejects non-finite and out-of-range values with a
 * {@link SpriteError} instead of clamping them silently.
 */
export class Anchor2D {
  #x: number;
  #y: number;

  constructor(init: Anchor2DInit = {}) {
    this.#x = Anchor2D.#validate(init.x ?? 0, "x");
    this.#y = Anchor2D.#validate(init.y ?? 0, "y");
  }

  /** Normalized horizontal anchor: `0` left edge, `0.5` center, `1` right edge. */
  get x(): number {
    return this.#x;
  }

  /** Normalized vertical anchor: `0` top edge, `0.5` center, `1` bottom edge. */
  get y(): number {
    return this.#y;
  }

  /**
   * Move the anchor to the given normalized coordinates. Both values must be
   * finite numbers between `0` and `1` (inclusive); anything else throws a
   * {@link SpriteError} and leaves the anchor unchanged. This is the only
   * mutation path.
   */
  set(x: number, y: number): void {
    // Validate both axes before assigning either, so a rejected call is a
    // no-op instead of a half-applied update.
    const nextX = Anchor2D.#validate(x, "x");
    const nextY = Anchor2D.#validate(y, "y");
    this.#x = nextX;
    this.#y = nextY;
  }

  static #validate(value: number, axis: "x" | "y"): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new SpriteError(
        `Anchor ${axis} must be a finite number between 0 and 1; received ${String(value)}.`,
      );
    }
    return value;
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
  /**
   * The normalized anchor/origin point. When omitted, the anchor defaults to
   * the top-left corner `(0, 0)`, preserving the pre-anchor placement
   * behavior. The sprite creates and owns its own {@link Anchor2D} from
   * these coordinates; mutate it through {@linkcode Sprite2D.anchor}.
   */
  readonly anchor?: Anchor2DInit;
  /**
   * Layering order relative to sibling display objects. Default `0`.
   * Higher values render in front of lower ones; sprites with equal
   * `zIndex` keep their attachment order. A plain mutable number like
   * `visible`/`alpha`; the renderer applies it on the next `sync()`.
   */
  readonly zIndex?: number;
}

/**
 * A minimal, renderer-independent sprite model: a typed texture reference, a
 * {@link Transform2D}, a normalized {@link Anchor2D} origin, and the visual
 * properties the current demos need (`visible`, `alpha`, `zIndex`). Core
 * never inspects or destroys the texture — it is a generic `TTexture` handle
 * supplied by the caller (typically from a renderer's asset API).
 *
 * The model is plain mutable data. A renderer adapter turns it into a display
 * object and applies changes through an explicit `sync()` call (see
 * `createSpriteView` in `@g2w/renderer-pixi`); mutating the model alone never
 * touches the renderer.
 *
 * The anchor is a property of the sprite, not of the transform: transforms
 * are shared between sprites and game objects, and a game object has no
 * visual, so a transform-level anchor would be meaningless.
 *
 * Intentionally unsupported: parent/child hierarchies, tint, blend modes,
 * animation timelines, and entity components.
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
  /**
   * The normalized anchor/origin point. Position is where the anchor lands,
   * and rotation and scale happen around it. Defaults to the top-left corner
   * `(0, 0)`; the only mutation path is {@linkcode Anchor2D.set}.
   */
  readonly anchor: Anchor2D;
  /**
   * Layering order relative to sibling display objects; higher values render
   * in front. Sprites with equal `zIndex` keep their attachment order.
   */
  zIndex: number;

  constructor(init: Sprite2DInit<TTexture>) {
    this.texture = init.texture;
    this.transform = init.transform ?? new Transform2D();
    this.visible = init.visible ?? true;
    this.alpha = init.alpha ?? 1;
    this.anchor = new Anchor2D(init.anchor ?? {});
    this.zIndex = init.zIndex ?? 0;
  }
}
