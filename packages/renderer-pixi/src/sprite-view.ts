import type { Sprite2D } from "@g2w/core";
import { type Container, Sprite, type Texture } from "pixi.js";

/**
 * Error thrown when a `SpriteView` is used against its documented contract,
 * e.g. synchronizing after disposal.
 */
export class SpriteViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpriteViewError";
  }
}

/** Options for {@link createSpriteView}. */
export interface SpriteViewInit<TTexture> {
  /** The core sprite model the view renders and keeps synchronized. */
  readonly sprite: Sprite2D<TTexture>;
  /**
   * The renderer whose stage the view is attached to. The view does not own
   * the renderer: disposing the view never touches the renderer or the stage,
   * only the view's own display object.
   */
  readonly renderer: { readonly stage: Container };
}

/**
 * The renderer-side view of a core {@link Sprite2D} model.
 *
 * Created through {@link createSpriteView}, which attaches a PixiJS `Sprite`
 * to the renderer's stage. The view is a pure projection of the model: call
 * `sync()` (explicitly, once per frame after the model changes — typically at
 * the end of the scene update) to apply position, rotation (radians),
 * scale, visibility, alpha, the normalized anchor, and the z-order. No
 * ticker, subscription, or second loop exists; the existing Game loop is the
 * only driver.
 *
 * Ownership:
 * - The **model** is owned by the caller (typically the game/scene code).
 * - The **view** (its PixiJS `Sprite`) is owned by whoever created it, and is
 *   released by `dispose()`, which removes the sprite from its parent and
 *   destroys the display object — **never the texture**. Textures live in
 *   PixiJS's shared `Assets` cache (see `createTextureAssetManager`); other
 *   sprites and subsystems may share them.
 * - Disposal is idempotent and leaves the stage and all other display
 *   objects untouched.
 */
export class SpriteView<TTexture> {
  readonly #sprite2d: Sprite2D<TTexture>;
  readonly #displayObject: Sprite;
  #disposed = false;

  constructor(sprite2d: Sprite2D<TTexture>, stage: Container) {
    this.#sprite2d = sprite2d;
    // PixiJS Sprite.destroy() does not destroy the texture by default, which
    // matches the framework's texture-ownership policy.
    this.#displayObject = new Sprite(sprite2d.texture as Texture);
    // Attach first, then apply the model: PixiJS only marks a parent's sort
    // dirty (and enables sortableChildren) when a zIndex changes on a child
    // that already has a parent, so the model's initial zIndex must be
    // applied after attachment to take effect.
    stage.addChild(this.#displayObject);
    this.#applyModel();
  }

  /** Whether the view has been disposed (terminal). */
  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Apply the current model state (position, rotation, scale, visibility,
   * alpha, anchor, z-order) to the display object. Throws
   * {@link SpriteViewError} after disposal.
   */
  sync(): void {
    if (this.#disposed) {
      throw new SpriteViewError("Cannot sync a disposed sprite view.");
    }
    this.#applyModel();
  }

  /**
   * Remove the display object from its parent and destroy it. The texture is
   * never destroyed, and neither the stage nor any other display object is
   * touched. Idempotent: repeated calls are no-ops.
   */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#displayObject.removeFromParent();
    this.#displayObject.destroy();
  }

  #applyModel(): void {
    const { transform, visible, alpha, anchor, zIndex } = this.#sprite2d;
    this.#displayObject.position.set(transform.x, transform.y);
    this.#displayObject.rotation = transform.rotation;
    this.#displayObject.scale.set(transform.scaleX, transform.scaleY);
    this.#displayObject.visible = visible;
    this.#displayObject.alpha = alpha;
    // PixiJS's Sprite.anchor uses the same normalized 0..1 space as the core
    // Anchor2D, so the mapping is direct: no offset math, no double
    // application, and the default (0, 0) preserves the top-left placement.
    // The anchor is a property of the sprite model, not of the (possibly
    // shared) Transform2D.
    this.#displayObject.anchor.set(anchor.x, anchor.y);
    // Assigning an unchanged zIndex is a no-op in PixiJS, so the stage only
    // becomes sortable when a z-order actually changes; children with equal
    // zIndex keep their attachment order (stable sort).
    this.#displayObject.zIndex = zIndex;
  }
}

/**
 * Create a view for a core {@link Sprite2D} model and attach it to the
 * renderer's stage.
 *
 * ```ts
 * const logo = new Sprite2D({ texture, transform: new Transform2D({ x: 16, y: 32 }) });
 * const view = createSpriteView({ sprite: logo, renderer });
 * // ...each frame, after the model changes:
 * view.sync();
 * // ...during teardown (the texture survives):
 * view.dispose();
 * ```
 *
 * Each call creates one new display object; dispose a view before creating
 * another one for the same model, or the stage will hold both.
 */
export function createSpriteView<TTexture>(init: SpriteViewInit<TTexture>): SpriteView<TTexture> {
  return new SpriteView<TTexture>(init.sprite, init.renderer.stage);
}
