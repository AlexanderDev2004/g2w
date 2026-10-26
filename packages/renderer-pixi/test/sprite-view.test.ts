import { type GameObject, GameObjectCollection, Sprite2D, Transform2D } from "@g2w/core";
import { Container, Sprite, Texture, TextureSource } from "pixi.js";
import { describe, expect, it } from "vitest";
import { createSpriteView, SpriteViewError } from "../src/index.js";

interface FakeTexture {
  id: string;
  destroyed: boolean;
}

function fakeTexture(id: string): FakeTexture {
  return { id, destroyed: false };
}

type FakeRenderer = { readonly stage: Container };

function fakeRenderer(): { renderer: FakeRenderer; stage: Container } {
  const stage = new Container();
  return { renderer: { stage }, stage };
}

describe("createSpriteView", () => {
  it("creates a view and attaches exactly one display object to the stage", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });

    const view = createSpriteView({ sprite, renderer });

    expect(view.disposed).toBe(false);
    expect(stage.children.length).toBe(1);
  });

  it("applies the initial model transform, visibility, and alpha on creation", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({
      texture: fakeTexture("logo"),
      transform: new Transform2D({ x: 24, y: 48, rotation: 0.5, scaleX: 2, scaleY: 3 }),
      visible: false,
      alpha: 0.5,
    });

    createSpriteView({ sprite, renderer });

    const displayObject = stage.children[0];
    if (displayObject === undefined) {
      throw new Error("the view was not attached to the stage");
    }
    expect(displayObject.x).toBe(24);
    expect(displayObject.y).toBe(48);
    expect(displayObject.rotation).toBeCloseTo(0.5);
    expect(displayObject.scale.x).toBe(2);
    expect(displayObject.scale.y).toBe(3);
    expect(displayObject.visible).toBe(false);
    expect(displayObject.alpha).toBeCloseTo(0.5);
  });

  it("sync applies model changes for position, rotation, scale, visibility, and alpha", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });
    const view = createSpriteView({ sprite, renderer });

    sprite.transform.x = 100;
    sprite.transform.y = -50;
    sprite.transform.rotation = Math.PI;
    sprite.transform.scaleX = 0.5;
    sprite.transform.scaleY = 1.5;
    sprite.visible = false;
    sprite.alpha = 0.1;
    view.sync();

    const displayObject = stage.children[0];
    if (displayObject === undefined) {
      throw new Error("the view was not attached to the stage");
    }
    expect(displayObject.x).toBe(100);
    expect(displayObject.y).toBe(-50);
    expect(displayObject.rotation).toBeCloseTo(Math.PI);
    expect(displayObject.scale.x).toBe(0.5);
    expect(displayObject.scale.y).toBe(1.5);
    expect(displayObject.visible).toBe(false);
    expect(displayObject.alpha).toBeCloseTo(0.1);
  });

  it("does not touch the display object until sync is called", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });
    const view = createSpriteView({ sprite, renderer });

    sprite.transform.x = 500;
    const displayObject = stage.children[0];
    if (displayObject === undefined) {
      throw new Error("the view was not attached to the stage");
    }
    expect(displayObject.x).toBe(0);
    view.sync();
    expect(displayObject.x).toBe(500);
  });

  it("disposal removes the display object and leaves the stage and siblings intact", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });
    const view = createSpriteView({ sprite, renderer });
    const unrelated = new Container();
    stage.addChild(unrelated);
    expect(stage.children.length).toBe(2);

    view.dispose();

    expect(stage.children.length).toBe(1);
    expect(stage.children[0]).toBe(unrelated);
    expect(unrelated.destroyed).toBeFalsy();
    expect(stage.destroyed).toBeFalsy();
  });

  it("disposal is idempotent and post-disposal sync throws SpriteViewError", () => {
    const { renderer } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });
    const view = createSpriteView({ sprite, renderer });

    view.dispose();
    expect(() => view.dispose()).not.toThrow();
    expect(view.disposed).toBe(true);
    expect(() => view.sync()).toThrow(SpriteViewError);
  });

  it("disposing a view never destroys its texture", () => {
    const { renderer } = fakeRenderer();
    const texture = fakeTexture("shared");
    const sprite = new Sprite2D<FakeTexture>({ texture });
    const view = createSpriteView({ sprite, renderer });

    view.dispose();

    // The model's texture handle is untouched: the same instance could still
    // be used by other sprites or subsystems (shared Assets cache).
    expect(texture.destroyed).toBe(false);
    expect(sprite.texture).toBe(texture);
  });

  it("create/dispose cycles never leave duplicate display objects", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });

    for (let i = 0; i < 3; i++) {
      const view = createSpriteView({ sprite, renderer });
      expect(stage.children.length).toBe(1);
      view.dispose();
      expect(stage.children.length).toBe(0);
    }
  });

  it("scene-style show/hide cycles reuse one view without duplicating objects", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<FakeTexture>({ texture: fakeTexture("logo") });
    const view = createSpriteView({ sprite, renderer });

    // enter/exit pairs of a scene toggling visibility through the model.
    for (let i = 0; i < 3; i++) {
      sprite.visible = true;
      view.sync();
      expect(stage.children.length).toBe(1);
      sprite.visible = false;
      view.sync();
    }

    expect(stage.children.length).toBe(1);
    view.dispose();
    expect(stage.children.length).toBe(0);
  });

  it("accepts any texture handle type, matching the generic model", () => {
    const { renderer } = fakeRenderer();
    // A string handle proves the view does not require a PixiJS Texture
    // object at the type level (the Pixi Sprite stores it unmodified until
    // render time).
    const sprite = new Sprite2D<string>({ texture: "fake-handle" });
    const view = createSpriteView({ sprite, renderer });

    expect(() => view.sync()).not.toThrow();
    view.dispose();
  });
});

describe("SpriteView texture safety with real PixiJS objects", () => {
  it("destroying the view's display object does not destroy a real Texture", () => {
    // Texture.WHITE is a built-in texture backed by its own source; creating
    // and destroying a Sprite of it never touches the texture itself.
    const { renderer } = fakeRenderer();
    const texture: Texture = Texture.WHITE;
    const sprite = new Sprite2D<Texture>({ texture });
    const view = createSpriteView({ sprite, renderer });

    view.dispose();

    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
  });

  it("game object cleanup through a collection never destroys the shared texture", () => {
    // R2 + R1 boundary: an object's destroy hook releases only what the
    // object itself created (its view); the texture — shared here with a
    // second sprite that outlives the first object — is never destroyed by
    // object, view, or collection cleanup.
    //
    // A real Texture is used deliberately: Sprite's constructor copies plain
    // fake-texture properties onto the instance, so a fake with its own
    // destroy() method shadows Sprite.destroy and cannot exercise the real
    // destroy path.
    const { renderer } = fakeRenderer();
    const texture = new Texture({ source: new TextureSource({ width: 4, height: 4 }) });
    const sprite = new Sprite2D<Texture>({ texture });
    const view = createSpriteView({ sprite, renderer });
    const otherSprite = new Sprite2D<Texture>({ texture });
    const otherView = createSpriteView({ sprite: otherSprite, renderer });

    const object: GameObject = {
      transform: sprite.transform,
      update() {},
      destroy() {
        view.dispose();
      },
    };
    const collection = new GameObjectCollection();
    collection.add(object);
    collection.update(1 / 60);
    collection.destroy();

    expect(view.disposed).toBe(true);
    expect(otherView.disposed).toBe(false);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
    // The surviving consumer still holds a valid texture.
    expect(otherSprite.texture).toBe(texture);
  });
});

describe("SpriteView anchor and z-order integration (R11)", () => {
  it("leaves the display object anchored at the top-left by default, preserving placement", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<Texture>({ texture: Texture.WHITE });
    createSpriteView({ sprite, renderer });

    const displayObject = stage.children[0];
    if (!(displayObject instanceof Sprite)) {
      throw new Error("the view did not attach a PixiJS Sprite");
    }
    expect(displayObject.anchor.x).toBe(0);
    expect(displayObject.anchor.y).toBe(0);
  });

  it("applies a center anchor so position, rotation, and scale revolve around it", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<Texture>({
      texture: Texture.WHITE,
      transform: new Transform2D({ x: 100, y: 50, rotation: Math.PI / 2, scaleX: 2, scaleY: 2 }),
      anchor: { x: 0.5, y: 0.5 },
    });
    createSpriteView({ sprite, renderer });

    const displayObject = stage.children[0];
    if (!(displayObject instanceof Sprite)) {
      throw new Error("the view did not attach a PixiJS Sprite");
    }
    // The anchor maps directly into PixiJS's identical normalized space;
    // position, rotation, and scale still come from the shared Transform2D.
    expect(displayObject.anchor.x).toBe(0.5);
    expect(displayObject.anchor.y).toBe(0.5);
    expect(displayObject.x).toBe(100);
    expect(displayObject.y).toBe(50);
    expect(displayObject.rotation).toBeCloseTo(Math.PI / 2);
    expect(displayObject.scale.x).toBe(2);
    expect(displayObject.scale.y).toBe(2);
  });

  it("applies a feet anchor and follows anchor changes made through set()", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<Texture>({
      texture: Texture.WHITE,
      anchor: { x: 0.5, y: 1 },
    });
    const view = createSpriteView({ sprite, renderer });

    const displayObject = stage.children[0];
    if (!(displayObject instanceof Sprite)) {
      throw new Error("the view did not attach a PixiJS Sprite");
    }
    expect(displayObject.anchor.x).toBe(0.5);
    expect(displayObject.anchor.y).toBe(1);

    sprite.anchor.set(0.5, 0.5);
    view.sync();
    expect(displayObject.anchor.x).toBe(0.5);
    expect(displayObject.anchor.y).toBe(0.5);
  });

  it("applies zIndex through sync so higher values render in front", () => {
    // Real PixiJS containers: a zIndex change marks the parent's sort dirty
    // and enables sortableChildren (verified against pixi.js 8.22's sort
    // mixin), and Array.sort is stable, so this proves actual PixiJS
    // ordering, not a mock.
    const { renderer, stage } = fakeRenderer();
    const foreground = new Sprite2D<Texture>({ texture: Texture.WHITE, zIndex: 10 });
    const background = new Sprite2D<Texture>({ texture: Texture.WHITE, zIndex: 0 });
    const foregroundView = createSpriteView({ sprite: foreground, renderer });
    const backgroundView = createSpriteView({ sprite: background, renderer });

    // Attachment order: foreground first, background second. With equal
    // zIndex this order would win; the zIndex values must override it.
    const attachedForeground = stage.children[0];
    const attachedBackground = stage.children[1];
    expect(stage.sortableChildren).toBe(true);

    stage.sortChildren();
    expect(stage.children[0]).toBe(attachedBackground);
    expect(stage.children[1]).toBe(attachedForeground);

    // Cross #1: raise the background above the foreground after creation.
    // If sync() failed to apply the new zIndex, the display object keeps
    // _zIndex 0, no sort is scheduled, and sortChildren() early-returns
    // with the old order — so this assertion really proves the change
    // reached PixiJS.
    background.zIndex = 20;
    backgroundView.sync();
    stage.sortChildren();
    expect(stage.children[0]).toBe(attachedForeground);
    expect(stage.children[1]).toBe(attachedBackground);

    // Cross #2: push the foreground back on top the same way. Proves the
    // foreground view (not just the background one) re-applies zIndex on
    // sync.
    foreground.zIndex = 30;
    foregroundView.sync();
    stage.sortChildren();
    expect(stage.children[0]).toBe(attachedBackground);
    expect(stage.children[1]).toBe(attachedForeground);
  });

  it("keeps attachment order for sprites with equal zIndex", () => {
    const { renderer, stage } = fakeRenderer();
    const first = new Sprite2D<Texture>({ texture: Texture.WHITE, zIndex: 10 });
    const second = new Sprite2D<Texture>({ texture: Texture.WHITE, zIndex: 10 });
    createSpriteView({ sprite: first, renderer });
    createSpriteView({ sprite: second, renderer });

    const attachedFirst = stage.children[0];
    const attachedSecond = stage.children[1];

    // Both attaches mark the stage sort dirty, so sortChildren() really
    // runs here; a stable sort must keep the attachment order for equal
    // zIndex values rather than reshuffling them.
    stage.sortChildren();
    expect(stage.children[0]).toBe(attachedFirst);
    expect(stage.children[1]).toBe(attachedSecond);
  });

  it("keeps z-order changes from interfering with anchor and transform state", () => {
    const { renderer, stage } = fakeRenderer();
    const sprite = new Sprite2D<Texture>({
      texture: Texture.WHITE,
      transform: new Transform2D({ x: 30, y: 40, rotation: 1 }),
      anchor: { x: 0.5, y: 0.5 },
      zIndex: 2,
    });
    const view = createSpriteView({ sprite, renderer });

    sprite.zIndex = 7;
    sprite.transform.x = 80;
    sprite.anchor.set(0, 1);
    view.sync();

    const displayObject = stage.children[0];
    if (!(displayObject instanceof Sprite)) {
      throw new Error("the view did not attach a PixiJS Sprite");
    }
    expect(displayObject.zIndex).toBe(7);
    expect(displayObject.x).toBe(80);
    expect(displayObject.y).toBe(40);
    expect(displayObject.rotation).toBeCloseTo(1);
    expect(displayObject.anchor.x).toBe(0);
    expect(displayObject.anchor.y).toBe(1);
  });
});
