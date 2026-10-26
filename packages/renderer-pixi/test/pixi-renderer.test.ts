import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Renderer, RendererError } from "@g2w/core";
import { type ApplicationOptions, Container, Sprite, Texture, TextureSource } from "pixi.js";
import { describe, expect, it } from "vitest";
import { type PixiApplicationLike, PixiRenderer } from "../src/index.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function readManifest(pkgDir: string): Promise<Record<string, unknown>> {
  const content = await readFile(
    path.join(workspaceRoot, "packages", pkgDir, "package.json"),
    "utf8",
  );
  return JSON.parse(content) as Record<string, unknown>;
}

/** Minimal canvas fake: the injected application never touches it. */
function fakeCanvas(): HTMLCanvasElement {
  return { width: 640, height: 360 } as HTMLCanvasElement;
}

describe("PixiRenderer", () => {
  it("implements the core renderer contract", () => {
    const renderer: Renderer = new PixiRenderer();

    expect(renderer.capabilities.id).toBe("pixi");
    expect(renderer.capabilities.displayName).toBe("PixiJS");
    expect(renderer.initialized).toBe(false);
  });

  it("rejects disposal of an uninitialized renderer with a RendererError", async () => {
    const renderer = new PixiRenderer();

    await expect(renderer.dispose()).rejects.toThrow(RendererError);
  });

  it("rejects rendering and stage access before initialization with a RendererError", () => {
    const renderer = new PixiRenderer();

    expect(() => renderer.render()).toThrow(RendererError);
    expect(() => renderer.stage).toThrow(RendererError);
  });
});

describe("dependency direction", () => {
  it("declares @g2w/core as a dependency", async () => {
    const manifest = await readManifest("renderer-pixi");
    const dependencies = manifest.dependencies as Record<string, string> | undefined;

    expect(dependencies?.["@g2w/core"]).toBeDefined();
  });

  it("is not a dependency of @g2w/core", async () => {
    const manifest = await readManifest("core");
    const dependencies = manifest.dependencies as Record<string, string> | undefined;

    expect(dependencies?.["@g2w/renderer-pixi"]).toBeUndefined();
  });
});

/**
 * R1 regression: renderer disposal must never destroy shared textures.
 *
 * The fake application below records what {@link PixiRenderer.dispose} asks
 * PixiJS to destroy and delegates the stage-destroy call to a real PixiJS
 * `Container`, so the assertions exercise PixiJS 8.22's actual destroy
 * semantics — including `Sprite.destroy` honoring `texture`/`textureSource`
 * flags — without needing a browser or GPU.
 */
describe("PixiRenderer disposal and texture ownership (R1)", () => {
  interface FakeApplication extends PixiApplicationLike {
    destroyRendererOptions: unknown;
    destroyTextureOptions: unknown;
    destroyCalls: number;
  }

  function fakeApplication(): { application: FakeApplication; stage: Container } {
    const stage = new Container();
    const application: FakeApplication = {
      init: async () => {},
      render: () => {},
      destroyCalls: 0,
      destroyRendererOptions: null,
      destroyTextureOptions: null,
      // Delegate to the real Container.destroy so the destroy-option flags
      // have their real PixiJS effects on the stage subtree.
      destroy(rendererOptions, textureOptions) {
        application.destroyCalls += 1;
        application.destroyRendererOptions = rendererOptions;
        application.destroyTextureOptions = textureOptions;
        stage.destroy(textureOptions);
      },
      stage,
      renderer: { resize: () => {} },
    };
    return { application, stage };
  }

  /** A plain texture like the ones PixiJS's Assets cache hands out. */
  function plainTexture(): Texture {
    return new Texture({ source: new TextureSource({ width: 4, height: 4 }) });
  }

  it("destroys stage display objects but never textures or texture sources on disposal", async () => {
    const { application } = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });

    const texture = plainTexture();
    const sprite = new Sprite(texture);
    application.stage.addChild(sprite);

    await renderer.dispose();

    // The renderer-owned display object is destroyed...
    expect(sprite.destroyed).toBe(true);
    // ...but the texture it displayed — the exact shape of a shared
    // Assets-cache texture — survives with its source intact.
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
    // No texture-destroying flag was requested at all.
    expect(application.destroyTextureOptions).toEqual({ children: true });
  });

  it("keeps a shared cached texture valid for consumers outside the stage", async () => {
    const { application } = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });

    // Two sprites share one texture: one on the stage, one held elsewhere
    // (what another manager or subsystem would hold).
    const texture = plainTexture();
    const onStage = new Sprite(texture);
    const offStage = new Sprite(texture);
    application.stage.addChild(onStage);

    await renderer.dispose();

    expect(onStage.destroyed).toBe(true);
    expect(offStage.destroyed).toBe(false);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
    // The surviving sprite's texture handle is still the same valid instance.
    expect(offStage.texture).toBe(texture);
    expect(offStage.texture.destroyed).toBe(false);
  });

  it("preserves a texture across disposal and re-initialization", async () => {
    const first = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => first.application });
    await renderer.initialize({ canvas: fakeCanvas() });

    const texture = plainTexture();
    const sprite = new Sprite(texture);
    first.application.stage.addChild(sprite);
    await renderer.dispose();
    expect(texture.destroyed).toBe(false);

    // A fresh renderer (new session) can display the same cached texture.
    const second = fakeApplication();
    const reinitialized = new PixiRenderer({ createApplication: () => second.application });
    await reinitialized.initialize({ canvas: fakeCanvas() });
    const reusedSprite = new Sprite(texture);
    second.application.stage.addChild(reusedSprite);

    expect(reusedSprite.texture).toBe(texture);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
  });

  it("rejects repeated disposal with a RendererError and destroys the application once", async () => {
    const { application } = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });

    await expect(renderer.dispose()).resolves.toBeUndefined();
    await expect(renderer.dispose()).rejects.toThrow(RendererError);
    expect(application.destroyCalls).toBe(1);
    expect(renderer.initialized).toBe(false);
  });

  it("leaves no destroyed application behind when initialization fails", async () => {
    const { application } = fakeApplication();
    application.init = async () => {
      throw new Error("no renderer backend");
    };
    const renderer = new PixiRenderer({ createApplication: () => application });

    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow(
      "no renderer backend",
    );

    // Partial initialization is not "initialized": stage, render, and dispose
    // all keep the uninitialized contract, and nothing is destroyed.
    expect(renderer.initialized).toBe(false);
    await expect(renderer.dispose()).rejects.toThrow(RendererError);
    expect(() => renderer.stage).toThrow(RendererError);
    expect(() => renderer.render()).toThrow(RendererError);
    expect(application.destroyCalls).toBe(0);
  });

  it("documents the hazard: PixiJS destroy flags with texture options DO destroy stage textures", () => {
    // Pins the PixiJS 8.22 semantics the policy relies on: if the renderer
    // ever passed texture/textureSource flags again (or PixiJS changed this
    // behavior), this test fails and R1 must be re-examined.
    const texture = plainTexture();
    const source = texture.source;
    const stage = new Container();
    stage.addChild(new Sprite(texture));

    stage.destroy({ children: true, texture: true, textureSource: true });

    // Texture.destroy() destroys the source and nulls the texture's reference
    // to it: any other sprite holding this texture is now broken.
    expect(texture.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(texture.source).toBeNull();
  });
});

/**
 * R3: logical-resolution sizing and resize.
 *
 * The fake application records the options `PixiRenderer.initialize` passes
 * to PixiJS and the calls it forwards to `renderer.resize`, so the tests pin
 * the actual PixiJS-facing configuration rather than the option fields.
 */
describe("PixiRenderer sizing and resize (R3)", () => {
  interface FakeApplication extends PixiApplicationLike {
    initOptions: Partial<ApplicationOptions> | null;
    resizeCalls: [width: number, height: number][];
    destroyCalls: number;
  }

  function fakeApplication(): FakeApplication {
    const application: FakeApplication = {
      init: async (options) => {
        application.initOptions = options ?? null;
      },
      render: () => {},
      destroy() {
        application.destroyCalls += 1;
      },
      stage: new Container(),
      renderer: {
        resize(width, height) {
          application.resizeCalls.push([width, height]);
        },
      },
      initOptions: null,
      resizeCalls: [],
      destroyCalls: 0,
    };
    return application;
  }

  it("passes no dimensions when none are configured, preserving the renderer default", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });

    expect(application.initOptions).not.toBeNull();
    const initOptions = application.initOptions ?? {};
    expect("width" in initOptions).toBe(false);
    expect("height" in initOptions).toBe(false);
  });

  it("passes explicit logical dimensions to the PixiJS application", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas(), width: 640, height: 360 });

    expect(application.initOptions?.width).toBe(640);
    expect(application.initOptions?.height).toBe(360);
    expect(application.initOptions?.autoDensity).toBe(true);
  });

  it("forwards logical dimensions and resolution together", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas(), width: 640, height: 360, resolution: 2 });

    expect(application.initOptions?.width).toBe(640);
    expect(application.initOptions?.height).toBe(360);
    expect(application.initOptions?.resolution).toBe(2);
  });

  it.each([
    ["only width", { width: 640 }],
    ["only height", { height: 360 }],
  ] as const)(
    "rejects %s with a RendererError before touching the application",
    async (_name, options) => {
      const application = fakeApplication();
      const renderer = new PixiRenderer({ createApplication: () => application });

      await expect(renderer.initialize({ canvas: fakeCanvas(), ...options })).rejects.toThrow(
        RendererError,
      );
      expect(application.initOptions).toBeNull();
      expect(renderer.initialized).toBe(false);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-positive or non-finite dimensions (%s)",
    async (invalid) => {
      const application = fakeApplication();
      const renderer = new PixiRenderer({ createApplication: () => application });

      await expect(
        renderer.initialize({ canvas: fakeCanvas(), width: invalid, height: 360 }),
      ).rejects.toThrow(RendererError);
      await expect(
        renderer.initialize({ canvas: fakeCanvas(), width: 640, height: invalid }),
      ).rejects.toThrow(RendererError);
      expect(application.initOptions).toBeNull();
    },
  );

  it("forwards resize to the PixiJS renderer after initialization", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas(), width: 640, height: 360 });

    renderer.resize(800, 600);

    expect(application.resizeCalls).toEqual([[800, 600]]);
    expect(application.destroyCalls).toBe(0);
  });

  it("rejects resize before initialization and after disposal", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });

    expect(() => renderer.resize(640, 360)).toThrow(RendererError);

    await renderer.initialize({ canvas: fakeCanvas() });
    await renderer.dispose();

    expect(() => renderer.resize(640, 360)).toThrow(RendererError);
    expect(application.resizeCalls).toEqual([]);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid resize dimensions (%s)",
    (invalid) => {
      const application = fakeApplication();
      const renderer = new PixiRenderer({ createApplication: () => application });

      expect(() => renderer.resize(invalid, 360)).toThrow(RendererError);
      expect(() => renderer.resize(640, invalid)).toThrow(RendererError);
      expect(application.resizeCalls).toEqual([]);
    },
  );

  it("keeps stage content and shared textures valid across resize and disposal", async () => {
    const application = fakeApplication();
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas(), width: 640, height: 360 });

    const texture = new Texture({ source: new TextureSource({ width: 4, height: 4 }) });
    const sprite = new Sprite(texture);
    application.stage.addChild(sprite);

    renderer.resize(320, 240);
    expect(sprite.destroyed).toBe(false);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);

    await renderer.dispose();
    expect(application.destroyCalls).toBe(1);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
  });
});
