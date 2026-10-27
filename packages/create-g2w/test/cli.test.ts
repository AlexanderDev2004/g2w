import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(packageDir, "template");

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "create-g2w-test-"));
  scratchDirs.push(dir);
  return dir;
}

function io() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
  };
}

async function readGenerated(dir: string, relative: string): Promise<string> {
  return readFile(path.join(dir, relative), "utf8");
}

describe("create-g2w argument handling", () => {
  it("prints usage and exits 0 for --help", async () => {
    const io_ = io();
    expect(await run(["--help"], io_)).toBe(0);
    expect(io_.logs.join("\n")).toContain("Usage:");
  });

  it("fails with exit 1 when the target directory is missing", async () => {
    const io_ = io();
    await expect(run([], io_)).rejects.toThrow(/Missing target directory/);
  });

  it("fails on unknown options", async () => {
    const io_ = io();
    await expect(run(["somewhere", "--bogus"], io_)).rejects.toThrow(/Unknown option: --bogus/);
  });

  it("fails on extra positional arguments", async () => {
    const io_ = io();
    await expect(run(["one", "two"], io_)).rejects.toThrow(/Unexpected extra argument: two/);
  });

  it("requires a value for --name", async () => {
    const io_ = io();
    await expect(run(["somewhere", "--name"], io_)).rejects.toThrow(/--name requires a value/);
  });

  it("suggests --name when the directory name cannot become a package name", async () => {
    const dir = await scratch();
    const target = path.join(dir, "My Game!");
    await expect(run([target], io())).rejects.toThrow(/--name <name>/);
  });

  it("sanitizes spaces in the directory name into a valid package name", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my game");
    await run([target], io());
    const manifest = JSON.parse(await readGenerated(target, "package.json")) as { name: string };
    expect(manifest.name).toBe("my-game");
  });
});

describe("create-g2w generation", () => {
  it("copies the whole template and substitutes the project name", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const io_ = io();
    const exitCode = await run([target], io_);

    expect(exitCode).toBe(0);
    // No template placeholder survives generation.
    const generated = ["package.json", "README.md", "index.html"] as const;
    for (const file of generated) {
      expect(await readGenerated(target, file)).not.toContain("{{PROJECT_NAME}}");
    }
    expect(io_.logs.join("\n")).toContain("pnpm dev");
  });

  it("copies every template file present on disk", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await run([target], io());

    const { readdir } = await import("node:fs/promises");
    async function list(base: string, prefix = ""): Promise<string[]> {
      const entries = await readdir(path.join(base, prefix), { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          files.push(...(await list(base, relative)));
        } else {
          files.push(relative);
        }
      }
      return files.sort();
    }

    const expected = await list(templateDir);
    const actual = await list(target);
    expect(actual).toEqual(expected);
  });

  it("pins the g2w and PixiJS dependency versions the template declares", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await run([target], io());

    const manifest = JSON.parse(await readGenerated(target, "package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@g2w/core"]).toBe("0.1.0");
    expect(manifest.dependencies["@g2w/runtime"]).toBe("0.1.0");
    expect(manifest.dependencies["@g2w/renderer-pixi"]).toBe("0.1.0");
    expect(manifest.dependencies["@g2w/input-dom"]).toBe("0.1.0");
    expect(manifest.dependencies["pixi.js"]).toBe("8.22.0");
    expect(manifest.devDependencies.vitest).toBe("^4.0.16");
  });

  it("generates a self-consistent project layout", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await run([target], io());

    // The HTML entry references the real source entry.
    const html = await readGenerated(target, "index.html");
    expect(html).toContain("/src/main.ts");
    // The main module imports the scene module that the test exercises.
    const main = await readGenerated(target, path.join("src", "main.ts"));
    expect(main).toContain("nextPlayerPosition");
    // The smoke hook the browser validation relies on is present.
    expect(main).toContain("__G2W_STARTED");
  });
});

describe("create-g2w destination safety", () => {
  it("refuses a non-empty destination without --force and names the collision", async () => {
    const dir = await scratch();
    const target = path.join(dir, "occupied");
    await mkdir(target);
    await writeFile(path.join(target, "user-file.txt"), "keep me");
    const io_ = io();

    await expect(run([target], io_)).rejects.toThrow(/user-file\.txt/);
    // The user file is untouched.
    expect(await readFile(path.join(target, "user-file.txt"), "utf8")).toBe("keep me");
  });

  it("with --force writes generated files without deleting foreign files", async () => {
    const dir = await scratch();
    const target = path.join(dir, "occupied");
    await mkdir(target);
    await writeFile(path.join(target, "user-file.txt"), "keep me");
    await run([target, "--force"], io());

    expect(await readFile(path.join(target, "user-file.txt"), "utf8")).toBe("keep me");
    expect(existsSync(path.join(target, "package.json"))).toBe(true);
  });

  it("succeeds into an existing empty directory", async () => {
    const dir = await scratch();
    const target = path.join(dir, "empty");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);
    await expect(run([target], io())).resolves.toBe(0);
  });

  it("refuses a destination that exists as a file", async () => {
    const dir = await scratch();
    const target = path.join(dir, "a-file");
    await writeFile(target, "not a directory");
    await expect(run([target], io())).rejects.toThrow(/not a directory/);
  });
});

describe("create-g2w template hygiene", () => {
  it("has no unresolved placeholder in the template sources", async () => {
    const { readdir } = await import("node:fs/promises");
    async function files(base: string, prefix = ""): Promise<string[]> {
      const entries = await readdir(path.join(base, prefix), { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          found.push(...(await files(base, relative)));
        } else {
          found.push(relative);
        }
      }
      return found;
    }
    for (const relative of await files(templateDir)) {
      const contents = await readFile(path.join(templateDir, relative), "utf8");
      // The only allowed placeholder is the project-name variable.
      expect(contents).not.toMatch(/\{\{(?!PROJECT_NAME\}\})/);
    }
  });

  it("the CLI source never spawns child processes", async () => {
    const source = await readFile(path.join(packageDir, "src", "cli.ts"), "utf8");
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn(Sync)?\(/);
    expect(source).not.toMatch(/\bexec(Sync)?\(/);
  });
});
