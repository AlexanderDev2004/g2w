import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createG2WRuntime } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const coreDir = fileURLToPath(new URL("../../core", import.meta.url));

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : Promise.resolve([entryPath]);
    }),
  );
  return files.flat();
}

describe("@g2w/runtime package boundary", () => {
  it("declares exactly @g2w/core and effect as dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@g2w/core", "effect"]);
    expect(manifest.dependencies?.effect).toBe("4.0.6");
    // The runtime must not pull in any rendering technology.
    expect(manifest.dependencies?.["pixi.js"]).toBeUndefined();
  });

  it("keeps @g2w/core free of Effect and browser/runtime adapter imports", async () => {
    const coreManifest = JSON.parse(
      await readFile(path.join(coreDir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    // Core stays dependency-free: Effect must never become a core dependency.
    expect(Object.keys(coreManifest.dependencies ?? {})).toEqual([]);

    const sourceFiles = await listFiles(path.join(coreDir, "src"));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports Effect`).not.toMatch(/from\s+["']effect["']/);
      expect(source, `${file} touches browser globals`).not.toMatch(/\bdocument\./);
      expect(source, `${file} imports a renderer adapter`).not.toMatch(/from\s+["'][^"']*pixi/);
    }
  });

  it("bootstraps the facade without any browser environment", async () => {
    const runtime = await createG2WRuntime();
    let released = false;
    runtime.addFinalizer(() => {
      released = true;
    });

    const value = await runtime.run(Effect.succeed(7));
    expect(value).toBe(7);

    await runtime.shutdown();
    expect(released).toBe(true);
  });
});
