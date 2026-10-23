import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Renderer, RendererError } from "@g2w/core";
import { describe, expect, it } from "vitest";
import { PixiRenderer } from "../src/index.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function readManifest(pkgDir: string): Promise<Record<string, unknown>> {
  const content = await readFile(
    path.join(workspaceRoot, "packages", pkgDir, "package.json"),
    "utf8",
  );
  return JSON.parse(content) as Record<string, unknown>;
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
