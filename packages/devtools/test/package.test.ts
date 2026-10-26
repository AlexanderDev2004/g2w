import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));

describe("@g2w/devtools package boundary", () => {
  it("declares @g2w/core as its only runtime dependency", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    expect(manifest.dependencies?.["@g2w/core"]).toBeDefined();
    // DevTools is a development tool: no rendering technology and no UI framework.
    expect(manifest.dependencies?.["pixi.js"]).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@g2w/core"]);
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it("is not a dependency of @g2w/core — the runtime never depends on DevTools", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(rootDir, "packages/core/package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.dependencies).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("@g2w/devtools");
  });
});
