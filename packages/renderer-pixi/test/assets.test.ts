import { AssetError, AssetManager } from "@g2w/core";
import type { Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { createTextureAssetManager } from "../src/index.js";

interface FakeTexture extends Texture {
  destroyCalls: number;
  destroyedWithSource: boolean | null;
}

function fakeTexture(): FakeTexture {
  const texture = {
    destroyed: false,
    destroyCalls: 0,
    destroyedWithSource: null,
  } as FakeTexture;
  texture.destroy = (destroySource = false) => {
    texture.destroyCalls += 1;
    texture.destroyed = true;
    texture.destroyedWithSource = destroySource;
  };
  return texture;
}

type LoadFn = (key: string) => Promise<Texture>;

function loaderReturning(texture: FakeTexture): LoadFn {
  // Mimics PixiJS Assets.load: the shared cache resolves every request for
  // the same URL to the same texture instance.
  return vi.fn(async () => texture as unknown as Texture);
}

describe("createTextureAssetManager", () => {
  it("returns a core AssetManager that loads textures through the injected loader", async () => {
    const texture = fakeTexture();
    const load = loaderReturning(texture);
    const assets = createTextureAssetManager({ load });

    expect(assets).toBeInstanceOf(AssetManager);
    await expect(assets.load("assets/logo.png")).resolves.toBe(texture);
    expect(load).toHaveBeenCalledWith("assets/logo.png");
    expect(texture.destroyCalls).toBe(0);
  });

  it("reuses the same texture instance for repeated and concurrent requests", async () => {
    const texture = fakeTexture();
    const load = loaderReturning(texture);
    const assets = createTextureAssetManager({ load });

    const first = assets.load("assets/logo.png");
    const second = assets.load("assets/logo.png");
    const third = assets.load("assets/logo.png");

    await expect(third).resolves.toBe(await first);
    await expect(second).resolves.toBe(texture);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not destroy textures on disposal: another manager may still use them", async () => {
    // PixiJS's Assets cache hands both managers the same instance; destroying
    // on one manager's disposal would invalidate the other's texture.
    const texture = fakeTexture();
    const load = loaderReturning(texture);
    const first = createTextureAssetManager({ load });
    const second = createTextureAssetManager({ load });
    await first.load("shared.png");
    await second.load("shared.png");

    await first.dispose();

    expect(texture.destroyCalls).toBe(0);
    expect(texture.destroyed).toBe(false);
    // The surviving manager's cache entry is untouched and still usable.
    await expect(second.load("shared.png")).resolves.toBe(texture);
  });

  it("keeps textures valid for sprites after any manager disposal", async () => {
    const texture = fakeTexture();
    const assets = createTextureAssetManager({ load: loaderReturning(texture) });
    await assets.load("assets/logo.png");

    await assets.dispose();

    // A sprite holding this texture is unaffected: no destroy call ever
    // happens through the adapter.
    expect(texture.destroyed).toBe(false);
    expect(texture.destroyCalls).toBe(0);
  });

  it("releases its own references on disposal without destroying the texture", async () => {
    const texture = fakeTexture();
    const load = loaderReturning(texture);
    const assets = createTextureAssetManager({ load });
    await assets.load("assets/logo.png");

    const disposal = assets.dispose();
    await expect(disposal).resolves.toBeUndefined();
    // Disposal is idempotent and terminal.
    await expect(assets.dispose()).resolves.toBeUndefined();
    expect(assets.disposed).toBe(true);
    expect(() => assets.load("assets/logo.png")).toThrow(AssetError);
    // The loader ran once in total; the texture survived the whole cycle.
    expect(load).toHaveBeenCalledTimes(1);
    expect(texture.destroyCalls).toBe(0);
  });

  it("leaves disposal clean when a load failed or is in flight", async () => {
    const texture = fakeTexture();
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("404");
      }
      return texture as unknown as Texture;
    });
    const assets = createTextureAssetManager({ load });

    // A failed load must not poison later cleanup or the retry.
    await expect(assets.load("missing.png")).rejects.toThrow("404");
    const retry = assets.load("missing.png");
    await expect(retry).resolves.toBe(texture);
    expect(texture.destroyCalls).toBe(0);

    // Disposal with nothing cached resolves cleanly and destroys nothing.
    const second = createTextureAssetManager({ load: loaderReturning(texture) });
    const pending = second.load("late.png");
    const disposal = second.dispose();
    await expect(pending).resolves.toBe(texture);
    await expect(disposal).resolves.toBeUndefined();
    expect(texture.destroyCalls).toBe(0);
  });
});
