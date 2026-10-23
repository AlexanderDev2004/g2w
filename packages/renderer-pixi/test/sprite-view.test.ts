import { Sprite2D, Transform2D } from "@g2w/core";
import { Container, Texture } from "pixi.js";
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
});
