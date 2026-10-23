import { type AssetLoader, AssetManager } from "@g2w/core";
import { Assets, type Texture } from "pixi.js";

/** Options for {@link createTextureAssetManager}. */
export interface TextureAssetManagerOptions {
  /**
   * Loads one texture for a URL. Defaults to PixiJS's global `Assets.load`.
   * Injectable so tests (and alternative resolvers) can substitute their own
   * loading behavior; production code should omit it.
   */
  readonly load?: AssetLoader<Texture>;
}

/**
 * Creates a core `AssetManager` that loads PixiJS textures by URL.
 *
 * Keys are URLs (or PixiJS resolver aliases) handed to `Assets.load`. The
 * manager caches and deduplicates like any core `AssetManager`: repeated and
 * concurrent requests for the same URL share one load and return the same
 * texture instance.
 *
 * Ownership policy — **non-destructive by design:** the adapter never destroys
 * the textures it loads. `Assets.load` stores every texture in PixiJS's global
 * shared cache, where any other manager, `Sprite.from`, or subsystem can reach
 * the same instance, and PixiJS offers no supported way to establish exclusive
 * ownership of a cached texture (`Assets.unload` destroys the texture no
 * matter who else still holds it). Destroying a cached texture on manager
 * disposal could therefore invalidate textures another manager or sprite still
 * uses. Instead, `dispose()` releases the manager's own references (its cache
 * entries) and leaves texture lifetime to the session: the textures remain in
 * PixiJS's cache until the page unloads, which reclaims all GPU and CPU
 * memory. When an application knows — outside the framework — that nothing
 * else uses a texture any more, it can call PixiJS's `Assets.unload(url)`
 * explicitly; that decision belongs to the application, not the manager.
 *
 * ```ts
 * const assets = createTextureAssetManager();
 * const logo = await assets.load("assets/logo.png");
 * const sprite = new Sprite(logo); // sprite owns nothing but its object
 * // ...later, during teardown:
 * await assets.dispose(); // releases the manager; the texture is NOT destroyed
 * ```
 */
export function createTextureAssetManager(
  options: TextureAssetManagerOptions = {},
): AssetManager<Texture> {
  const load = options.load ?? ((key: string) => Assets.load(key));
  // No disposer: values from the shared Assets cache are not owned by this
  // manager, so core's caller-owned policy applies (dispose clears entries).
  return new AssetManager<Texture>({ load });
}
