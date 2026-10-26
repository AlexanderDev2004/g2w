import { Anchor2D, Sprite2D, SpriteError, Transform2D } from "@g2w/core";
import { describe, expect, it } from "vitest";

interface FakeTexture {
  id: string;
}

const fakeTexture: FakeTexture = { id: "tex-1" };

describe("Transform2D", () => {
  it("defaults to position 0, rotation 0, and natural scale", () => {
    const transform = new Transform2D();

    expect(transform.x).toBe(0);
    expect(transform.y).toBe(0);
    expect(transform.rotation).toBe(0);
    expect(transform.scaleX).toBe(1);
    expect(transform.scaleY).toBe(1);
  });

  it("accepts custom initial values", () => {
    const transform = new Transform2D({ x: 10, y: -20, rotation: 1.5, scaleX: 2, scaleY: 0.5 });

    expect(transform.x).toBe(10);
    expect(transform.y).toBe(-20);
    expect(transform.rotation).toBe(1.5);
    expect(transform.scaleX).toBe(2);
    expect(transform.scaleY).toBe(0.5);
  });

  it("accepts partial overrides and keeps the remaining defaults", () => {
    const transform = new Transform2D({ y: 42 });

    expect(transform.x).toBe(0);
    expect(transform.y).toBe(42);
    expect(transform.scaleX).toBe(1);
    expect(transform.scaleY).toBe(1);
  });

  it("treats rotation as radians, preserving any numeric value unchanged", () => {
    const quarter = new Transform2D({ rotation: Math.PI / 2 });
    const full = new Transform2D({ rotation: Math.PI * 2 });
    const negative = new Transform2D({ rotation: -Math.PI / 6 });

    expect(quarter.rotation).toBeCloseTo(1.5707963);
    expect(full.rotation).toBeCloseTo(6.2831853);
    expect(negative.rotation).toBeCloseTo(-0.5235988);
  });

  it("is mutable in place without setters or validation machinery", () => {
    const transform = new Transform2D();

    transform.x = 120;
    transform.y = 64;
    transform.rotation += 0.5;
    transform.scaleX = 3;
    transform.scaleY = transform.scaleX;

    expect(transform.x).toBe(120);
    expect(transform.y).toBe(64);
    expect(transform.rotation).toBe(0.5);
    expect(transform.scaleX).toBe(3);
    expect(transform.scaleY).toBe(3);
  });
});

describe("Sprite2D", () => {
  it("holds a typed texture reference and defaults to visible and opaque", () => {
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture });

    expect(sprite.texture).toBe(fakeTexture);
    expect(sprite.visible).toBe(true);
    expect(sprite.alpha).toBe(1);
    expect(sprite.transform.x).toBe(0);
    expect(sprite.transform.rotation).toBe(0);
    expect(sprite.transform.scaleX).toBe(1);
  });

  it("accepts a shared transform so several sprites can be driven together", () => {
    const shared = new Transform2D({ x: 5, y: 6 });
    const a = new Sprite2D<FakeTexture>({ texture: fakeTexture, transform: shared });
    const b = new Sprite2D<FakeTexture>({ texture: fakeTexture, transform: shared });

    expect(a.transform).toBe(shared);
    expect(b.transform).toBe(shared);
    shared.x = 99;
    expect(a.transform.x).toBe(99);
    expect(b.transform.x).toBe(99);
  });

  it("accepts custom visual properties", () => {
    const sprite = new Sprite2D<FakeTexture>({
      texture: fakeTexture,
      visible: false,
      alpha: 0.25,
      transform: new Transform2D({ x: 7, rotation: 0.25, scaleY: 2 }),
    });

    expect(sprite.visible).toBe(false);
    expect(sprite.alpha).toBe(0.25);
    expect(sprite.transform.x).toBe(7);
    expect(sprite.transform.rotation).toBe(0.25);
    expect(sprite.transform.scaleY).toBe(2);
  });

  it("keeps the texture generic: any handle type works and is never inspected", () => {
    // A plain string handle proves core does not require a texture object.
    const sprite = new Sprite2D<string>({ texture: "assets/logo.png" });

    expect(sprite.texture).toBe("assets/logo.png");
  });

  it("allows mutating visual properties directly", () => {
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture });

    sprite.visible = false;
    sprite.alpha = 0;

    expect(sprite.visible).toBe(false);
    expect(sprite.alpha).toBe(0);
  });
});

describe("Anchor2D", () => {
  it("defaults to the top-left corner", () => {
    const anchor = new Anchor2D();

    expect(anchor.x).toBe(0);
    expect(anchor.y).toBe(0);
  });

  it("accepts normalized initial coordinates", () => {
    const center = new Anchor2D({ x: 0.5, y: 0.5 });
    const feet = new Anchor2D({ x: 0.5, y: 1 });

    expect(center.x).toBe(0.5);
    expect(center.y).toBe(0.5);
    expect(feet.x).toBe(0.5);
    expect(feet.y).toBe(1);
  });

  it("mutates only through set(), which accepts the full normalized range", () => {
    const anchor = new Anchor2D();

    anchor.set(1, 0);
    expect(anchor.x).toBe(1);
    expect(anchor.y).toBe(0);

    anchor.set(0.25, 0.75);
    expect(anchor.x).toBe(0.25);
    expect(anchor.y).toBe(0.75);
  });

  it("rejects out-of-range, negative, and non-finite coordinates with SpriteError", () => {
    const anchor = new Anchor2D();

    for (const invalid of [
      -0.01,
      1.01,
      -1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => anchor.set(invalid, 0.5)).toThrow(SpriteError);
      expect(() => anchor.set(0.5, invalid)).toThrow(SpriteError);
      expect(() => new Anchor2D({ x: invalid })).toThrow(SpriteError);
      expect(() => new Anchor2D({ y: invalid })).toThrow(SpriteError);
    }

    // A rejected set must not have modified the anchor.
    expect(anchor.x).toBe(0);
    expect(anchor.y).toBe(0);
  });

  it("accepts the inclusive edges 0 and 1", () => {
    const anchor = new Anchor2D();

    anchor.set(0, 1);
    expect(anchor.x).toBe(0);
    expect(anchor.y).toBe(1);

    anchor.set(1, 0);
    expect(anchor.x).toBe(1);
    expect(anchor.y).toBe(0);
  });
});

describe("Sprite2D anchors and z-order", () => {
  it("defaults to the top-left anchor and zIndex 0, preserving existing placement", () => {
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture });

    expect(sprite.anchor.x).toBe(0);
    expect(sprite.anchor.y).toBe(0);
    expect(sprite.zIndex).toBe(0);
  });

  it("accepts initial anchor coordinates and zIndex", () => {
    const sprite = new Sprite2D<FakeTexture>({
      texture: fakeTexture,
      anchor: { x: 0.5, y: 1 },
      zIndex: 3,
    });

    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(1);
    expect(sprite.zIndex).toBe(3);
  });

  it("rejects an invalid initial anchor", () => {
    expect(() => new Sprite2D<FakeTexture>({ texture: fakeTexture, anchor: { x: 1.5 } })).toThrow(
      SpriteError,
    );
  });

  it("gives each sprite its own anchor instance", () => {
    const a = new Sprite2D<FakeTexture>({ texture: fakeTexture });
    const b = new Sprite2D<FakeTexture>({ texture: fakeTexture });

    expect(a.anchor).not.toBe(b.anchor);
    a.anchor.set(0.5, 0.5);
    expect(b.anchor.x).toBe(0);
    expect(b.anchor.y).toBe(0);
  });

  it("keeps the anchor independent of a shared transform", () => {
    const shared = new Transform2D({ x: 10, y: 20 });
    const character = new Sprite2D<FakeTexture>({
      texture: fakeTexture,
      transform: shared,
      anchor: { x: 0.5, y: 1 },
    });
    const projectile = new Sprite2D<FakeTexture>({ texture: fakeTexture, transform: shared });

    shared.x = 50;
    expect(character.transform.x).toBe(50);
    expect(projectile.transform.x).toBe(50);
    expect(character.anchor.y).toBe(1);
    expect(projectile.anchor.y).toBe(0);
  });

  it("exposes zIndex as a plain mutable number", () => {
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture });

    sprite.zIndex = -5;
    expect(sprite.zIndex).toBe(-5);
    sprite.zIndex += 10;
    expect(sprite.zIndex).toBe(5);
  });
});
