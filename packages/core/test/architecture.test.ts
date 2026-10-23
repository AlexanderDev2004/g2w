import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function declaredDependencies(manifest: Record<string, unknown>): string[] {
  const groups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return groups.flatMap((group) =>
    Object.keys((manifest[group] as Record<string, string> | undefined) ?? {}),
  );
}

async function listSourceFiles(dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await listSourceFiles(entryPath, files);
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("core architecture boundary", () => {
  it("declares no runtime dependencies", async () => {
    const manifest = await readManifest();

    expect(manifest.dependencies).toBeUndefined();
  });

  it("does not depend on PixiJS in any dependency group", async () => {
    const manifest = await readManifest();

    expect(declaredDependencies(manifest)).not.toContain("pixi.js");
  });

  it("never imports a concrete renderer technology in source", async () => {
    const sourceFiles = await listSourceFiles(`${packageDir}/src`);

    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const content = await readFile(file, "utf8");
      // Match import-like references to a concrete renderer, not doc comments:
      // static, type-only, and dynamic import() forms.
      expect(content).not.toMatch(/(?:^|[\s(])from\s+["'][^"']*pixi/);
      expect(content).not.toMatch(/import\s*\(\s*["'][^"']*pixi/);
      expect(content).not.toMatch(/import\s+["'][^"']*pixi/);
    }
  });
});
