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
    initCalls: number;
    destroyRendererOptions: unknown;
    destroyTextureOptions: unknown;
    destroyCalls: number;
  }

  function fakeApplication(): { application: FakeApplication; stage: Container } {
    const stage = new Container();
    const application: FakeApplication = {
      init: async () => {
        application.initCalls += 1;
      },
      render: () => {},
      initCalls: 0,
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
      renderer: { name: "webgl", resize: () => {} },
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

  it("rolls back a failed initialization by destroying the partial application", async () => {
    const { application } = fakeApplication();
    application.init = async () => {
      application.initCalls += 1;
      if (application.initCalls === 1) {
        throw new Error("no renderer backend");
      }
    };
    const renderer = new PixiRenderer({ createApplication: () => application });

    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow(
      "no renderer backend",
    );

    // The partially initialized application was rolled back exactly once...
    expect(application.destroyCalls).toBe(1);
    // ...partial initialization is not "initialized": stage, render, and
    // dispose all keep the uninitialized contract...
    expect(renderer.initialized).toBe(false);
    await expect(renderer.dispose()).rejects.toThrow(RendererError);
    expect(() => renderer.stage).toThrow(RendererError);
    expect(() => renderer.render()).toThrow(RendererError);
    // ...and the renderer can be initialized again after the failure.
    await renderer.initialize({ canvas: fakeCanvas() });
    expect(renderer.initialized).toBe(true);
    expect(application.initCalls).toBe(2);
    await renderer.dispose();
    expect(application.destroyCalls).toBe(2);
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
        name: "webgl",
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

/**
 * E3-B lifecycle regressions: concurrent initialization coalescing,
 * failure rollback with observable causes, and disposal-during-init.
 * The gated fake parks `init()` on a deferred promise the test releases,
 * so every interleaving is deterministic — no timers, no real PixiJS.
 */
describe("PixiRenderer lifecycle (E3-B)", () => {
  interface LifecycleFake extends PixiApplicationLike {
    initCalls: number;
    destroyCalls: number;
  }

  /**
   * An application whose `init()` parks until `release()` is called.
   * `initialize()` runs synchronously up to parking the fake, so a test can
   * call `release()` right after starting initialization without any entry
   * synchronization.
   */
  function gatedApplication(): {
    application: LifecycleFake;
    release: (error?: Error) => void;
  } {
    let releaser: ((error?: Error) => void) | null = null;
    const application: LifecycleFake = {
      initCalls: 0,
      destroyCalls: 0,
      init: async () => {
        application.initCalls += 1;
        await new Promise<void>((resolve, reject) => {
          releaser = (error?: Error) => (error === undefined ? resolve() : reject(error));
        });
      },
      render: () => {},
      destroy: () => {
        application.destroyCalls += 1;
      },
      stage: new Container(),
      renderer: { name: "webgl", resize: () => {} },
    };
    return {
      application,
      release: (error?: Error) => {
        const current = releaser;
        releaser = null;
        current?.(error);
      },
    };
  }

  it("coalesces concurrent initialize calls into one application", async () => {
    let created = 0;
    const gate = gatedApplication();
    const renderer = new PixiRenderer({
      createApplication: () => {
        created += 1;
        return gate.application;
      },
    });

    const first = renderer.initialize({ canvas: fakeCanvas() });
    const second = renderer.initialize({ canvas: fakeCanvas() });
    expect(second).toBe(first);

    gate.release();
    await Promise.all([first, second]);

    expect(created).toBe(1);
    expect(gate.application.initCalls).toBe(1);
    expect(renderer.initialized).toBe(true);

    // No leak: the single application is destroyed exactly once.
    await renderer.dispose();
    expect(gate.application.destroyCalls).toBe(1);
  });

  it("keeps the uninitialized contract while initialization is pending", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    expect(renderer.initialized).toBe(false);
    expect(() => renderer.stage).toThrow(RendererError);
    expect(() => renderer.render()).toThrow(RendererError);
    expect(() => renderer.resize(320, 240)).toThrow(RendererError);

    gate.release();
    await pending;
    expect(renderer.initialized).toBe(true);
    await renderer.dispose();
  });

  it("rejects a second initialization after the first completed", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const first = renderer.initialize({ canvas: fakeCanvas() });
    gate.release();
    await first;

    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow(
      "already initialized",
    );

    await renderer.dispose();
  });

  it("aggregates a rollback failure with the original initialization error", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });
    const initBoom = new Error("init boom");
    const cleanupBoom = new Error("cleanup boom");

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    // Only the first rollback destroy fails; the later successful
    // initialization must be disposable again.
    gate.application.destroy = () => {
      gate.application.destroyCalls += 1;
      if (gate.application.destroyCalls === 1) {
        throw cleanupBoom;
      }
    };
    gate.release(initBoom);

    const settled = await pending.then(
      () => "fulfilled",
      (error: unknown) => error,
    );
    expect(settled).toBeInstanceOf(AggregateError);
    expect([...(settled as AggregateError).errors]).toEqual([initBoom, cleanupBoom]);

    // The renderer is back to a state that can be initialized again.
    expect(renderer.initialized).toBe(false);
    const retry = renderer.initialize({ canvas: fakeCanvas() });
    gate.release();
    await retry;
    expect(renderer.initialized).toBe(true);
    await renderer.dispose();
  });

  it("waits for a pending initialization before disposing", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    const disposal = renderer.dispose();
    gate.release();
    await pending;
    await disposal;

    expect(gate.application.destroyCalls).toBe(1);
    expect(renderer.initialized).toBe(false);
  });

  it("settles a deferred disposal when the pending initialization fails", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    const disposal = renderer.dispose();
    gate.release(new Error("init boom"));

    await expect(pending).rejects.toThrow("init boom");
    // A failed initialization is not a disposal failure: its rollback
    // already released the partial application.
    await expect(disposal).resolves.toBeUndefined();
    expect(gate.application.destroyCalls).toBe(1);
    expect(renderer.initialized).toBe(false);
    await expect(renderer.dispose()).rejects.toThrow(RendererError);
  });

  it("shares one disposal across concurrent dispose-during-init calls", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    const first = renderer.dispose();
    const second = renderer.dispose();
    expect(second).toBe(first);

    gate.release();
    await Promise.all([pending, first, second]);
    expect(gate.application.destroyCalls).toBe(1);
  });

  it("keeps the fire-and-forget dispose(); initialize() sequence working", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const first = renderer.initialize({ canvas: fakeCanvas() });
    gate.release();
    await first;
    // No await between dispose and initialize — destroy happens
    // synchronously, so this historical sequence keeps working.
    const disposal = renderer.dispose();
    const reinit = renderer.initialize({ canvas: fakeCanvas() });
    gate.release();
    await disposal;
    await reinit;

    expect(gate.application.initCalls).toBe(2);
    expect(gate.application.destroyCalls).toBe(1);
    expect(renderer.initialized).toBe(true);
  });

  it("rejects an initialize that arrives after a deferred disposal started", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    const disposal = renderer.dispose();

    // The disposal must win: joining the pending init would resolve this
    // promise even though the disposal is about to destroy the application.
    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow(
      "PixiRenderer is disposing",
    );

    gate.release();
    await pending;
    await disposal;
    expect(gate.application.destroyCalls).toBe(1);
    expect(renderer.initialized).toBe(false);
  });

  it("resets the lifecycle and stays retryable when application creation fails", async () => {
    let createCalls = 0;
    const gate = gatedApplication();
    const renderer = new PixiRenderer({
      createApplication: () => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error("no canvas");
        }
        return gate.application;
      },
    });

    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow("no canvas");
    expect(renderer.initialized).toBe(false);

    // The rejected first init must not poison later calls via coalescing.
    const retry = renderer.initialize({ canvas: fakeCanvas() });
    gate.release();
    await retry;
    expect(renderer.initialized).toBe(true);
    await renderer.dispose();
    expect(gate.application.destroyCalls).toBe(1);
  });

  it("surfaces a rollback cleanup failure to the deferred disposal caller", async () => {
    const gate = gatedApplication();
    const renderer = new PixiRenderer({ createApplication: () => gate.application });

    const pending = renderer.initialize({ canvas: fakeCanvas() });
    // Rollback destroy fails, so the init promise settles with an
    // AggregateError instead of a plain error.
    gate.application.destroy = () => {
      gate.application.destroyCalls += 1;
      throw new Error("cleanup boom");
    };
    gate.release(new Error("init boom"));

    const disposal = renderer.dispose();
    const settled = await pending.then(
      () => "fulfilled",
      (error: unknown) => error,
    );
    expect(settled).toBeInstanceOf(AggregateError);

    // The disposal must not swallow the cleanup failure...
    const disposalOutcome = await disposal.then(
      () => "fulfilled",
      (error: unknown) => error,
    );
    expect(disposalOutcome).toBe(settled);
    // ...but the renderer still resets so it can be initialized again.
    expect(renderer.initialized).toBe(false);
    await expect(renderer.dispose()).rejects.toThrow(RendererError);
  });
});
/**
 * R6-1: backend selection and actual-backend reporting.
 *
 * The fake application records the full init-options object (so the
 * forwarding of the backend preference to PixiJS's `preference` option is
 * pinned) and exposes an adjustable `renderer.name`, which is the public
 * property PixiJS sets on the concrete renderer class it actually created.
 * Reporting tests set a name that differs from the requested preference to
 * pin that the capability reports what runs, not what was requested.
 */
describe("PixiRenderer backend selection and reporting (R6-1)", () => {
  interface BackendFakeApplication extends PixiApplicationLike {
    initOptions: Partial<ApplicationOptions> | null;
    destroyCalls: number;
    failInit: boolean;
  }

  function backendApplication(name: string): BackendFakeApplication {
    const application: BackendFakeApplication = {
      init: async (options) => {
        application.initOptions = options ?? null;
        if (application.failInit) {
          throw new Error("init failed");
        }
      },
      render: () => {},
      destroy() {
        application.destroyCalls += 1;
      },
      stage: new Container(),
      renderer: {
        name,
        resize: () => {},
      },
      initOptions: null,
      destroyCalls: 0,
      failInit: false,
    };
    return application;
  }

  it("keeps PixiJS auto-detection when no backend preference is configured", async () => {
    const application = backendApplication("webgl");
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });

    expect(application.initOptions).not.toBeNull();
    expect("preference" in (application.initOptions ?? {})).toBe(false);
  });

  it.each(["webgl", "webgpu", "canvas"] as const)(
    "forwards an explicit %s backend preference to PixiJS",
    async (backend) => {
      const application = backendApplication(backend);
      const renderer = new PixiRenderer({ createApplication: () => application });
      await renderer.initialize({ canvas: fakeCanvas(), backend });

      expect(application.initOptions?.preference).toBe(backend);
    },
  );

  it("reports the actually initialized backend from the renderer, not the preference", async () => {
    // The preference asks for webgpu, but the application reports that the
    // concrete renderer created was webgl (a fallback): the capability must
    // expose webgl — what runs — never the requested webgpu.
    const application = backendApplication("webgl");
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas(), backend: "webgpu" });

    expect(application.initOptions?.preference).toBe("webgpu");
    expect(renderer.capabilities.backend).toBe("webgl");
    expect(renderer.backend).toBe("webgl");
  });

  it("reports no backend before initialization and after disposal", async () => {
    const application = backendApplication("webgl");
    const renderer = new PixiRenderer({ createApplication: () => application });
    expect(renderer.capabilities.backend).toBeUndefined();
    expect(renderer.backend).toBeUndefined();

    await renderer.initialize({ canvas: fakeCanvas() });
    expect(renderer.capabilities.backend).toBe("webgl");

    await renderer.dispose();
    expect(renderer.capabilities.backend).toBeUndefined();
    expect(renderer.backend).toBeUndefined();
    expect(renderer.initialized).toBe(false);
  });

  it("clears the backend report when a failed initialization rolls back", async () => {
    const application = backendApplication("webgl");
    application.failInit = true;
    const renderer = new PixiRenderer({ createApplication: () => application });

    await expect(renderer.initialize({ canvas: fakeCanvas(), backend: "webgl" })).rejects.toThrow(
      "init failed",
    );
    expect(application.destroyCalls).toBe(1);
    expect(renderer.capabilities.backend).toBeUndefined();
    expect(renderer.initialized).toBe(false);

    // Retry after the failure initializes cleanly and reports again.
    application.failInit = false;
    await renderer.initialize({ canvas: fakeCanvas(), backend: "webgl" });
    expect(renderer.capabilities.backend).toBe("webgl");
  });

  it("cleans up and stays retryable when backend detection fails after a successful init", async () => {
    const application = backendApplication("webgl");
    // Simulate detection failing on the just-initialized application.
    Object.defineProperty(application.renderer, "name", {
      get() {
        throw new Error("backend detection failed");
      },
    });
    const renderer = new PixiRenderer({ createApplication: () => application });

    await expect(renderer.initialize({ canvas: fakeCanvas() })).rejects.toThrow(
      "backend detection failed",
    );
    expect(application.destroyCalls).toBe(1);
    expect(renderer.capabilities.backend).toBeUndefined();
    expect(renderer.initialized).toBe(false);
  });

  it("re-reports the backend on reinitialization after disposal", async () => {
    const application = backendApplication("canvas");
    const renderer = new PixiRenderer({ createApplication: () => application });
    await renderer.initialize({ canvas: fakeCanvas() });
    expect(renderer.capabilities.backend).toBe("canvas");

    await renderer.dispose();
    await renderer.initialize({ canvas: fakeCanvas() });
    expect(renderer.capabilities.backend).toBe("canvas");
  });
});
