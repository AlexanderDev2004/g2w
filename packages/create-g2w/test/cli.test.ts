import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type GitCommandResult, type GitRunner, run } from "../src/cli.js";

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

/** Fake Git runner: records invocations, succeeds by default. */
function fakeGit(result: Partial<GitCommandResult> = {}): {
  calls: { args: string[]; cwd: string }[];
  runner: GitRunner;
} {
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: GitRunner = (args, cwd) => {
    calls.push({ args, cwd });
    return { status: 0, ...result };
  };
  return { calls, runner };
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
    await run([target], io(), fakeGit().runner);
    const manifest = JSON.parse(await readGenerated(target, "package.json")) as { name: string };
    expect(manifest.name).toBe("my-game");
  });
});

describe("create-g2w generation", () => {
  it("copies the whole template and substitutes the project name", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const io_ = io();
    const exitCode = await run([target], io_, fakeGit().runner);

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
    await run([target], io(), fakeGit().runner);

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
    await run([target], io(), fakeGit().runner);

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
    await run([target], io(), fakeGit().runner);

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
    await run([target, "--force"], io(), fakeGit().runner);

    expect(await readFile(path.join(target, "user-file.txt"), "utf8")).toBe("keep me");
    expect(existsSync(path.join(target, "package.json"))).toBe(true);
  });

  it("succeeds into an existing empty directory", async () => {
    const dir = await scratch();
    const target = path.join(dir, "empty");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);
    await expect(run([target], io(), fakeGit().runner)).resolves.toBe(0);
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

  it("the CLI spawns no shell and invokes only git", async () => {
    const source = await readFile(path.join(packageDir, "src", "cli.ts"), "utf8");
    // No shell command strings: Git runs through an explicit argv array only.
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/\bexec(Sync)?\(/);
    // The single subprocess is `git`, spawned with a literal executable name.
    expect(source.match(/spawnSync\(/g)).toHaveLength(1);
    expect(source).toContain('spawnSync("git"');
  });

  it("the generated .gitignore covers dependencies, build output, caches, and env files", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await run([target], io(), fakeGit().runner);

    const gitignore = await readGenerated(target, ".gitignore");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".vite/");
    expect(gitignore).toContain(".env");
    // The manifest itself must stay tracked.
    expect(gitignore).not.toMatch(/^package\.json$/m);
  });
});

describe("create-g2w git initialization", () => {
  it("runs git init with explicit arguments in the destination directory", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const fake = fakeGit();
    const io_ = io();

    await expect(run([target], io_, fake.runner)).resolves.toBe(0);
    expect(fake.calls).toEqual([{ args: ["init"], cwd: target }]);
    expect(io_.logs.join("\n")).toContain("Initialized an empty Git repository");
    // Local-only: never a remote, commit, or push.
    expect(fake.calls[0]?.args).toEqual(["init"]);
  });

  it("verifies the Git result before reporting overall success", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const io_ = io();

    await expect(run([target], io_, fakeGit().runner)).resolves.toBe(0);
    const log = io_.logs.join("\n");
    // The Git outcome is decided (and logged) before the success report.
    expect(log.indexOf("Initialized an empty Git repository")).toBeGreaterThan(-1);
    expect(log.indexOf("Created a g2w project")).toBeGreaterThan(
      log.indexOf("Initialized an empty Git repository"),
    );
    expect(existsSync(path.join(target, "package.json"))).toBe(true);
  });

  it("skips initialization when the destination already contains a .git directory", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await mkdir(path.join(target, ".git"), { recursive: true });
    await writeFile(path.join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
    const fake = fakeGit();
    const io_ = io();

    // An existing .git makes the destination non-empty, so generation
    // requires --force — which must leave the repository metadata untouched.
    await expect(run([target, "--force"], io_, fake.runner)).resolves.toBe(0);
    expect(fake.calls).toEqual([]);
    expect(io_.logs.join("\n")).toContain("Skipped Git initialization");
    expect(await readFile(path.join(target, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );
  });

  it("recognizes a .git file (worktree metadata) as an existing repository", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    await mkdir(target);
    await writeFile(path.join(target, ".git"), "gitdir: ../elsewhere/.git/worktrees/my-game\n");
    const fake = fakeGit();
    const io_ = io();

    // An existing .git makes the destination non-empty, so generation
    // requires --force — which must leave the metadata file untouched.
    await expect(run([target, "--force"], io_, fake.runner)).resolves.toBe(0);
    expect(fake.calls).toEqual([]);
    expect(io_.logs.join("\n")).toContain("Skipped Git initialization");
    expect(await readFile(path.join(target, ".git"), "utf8")).toContain("gitdir: ../elsewhere");
  });

  it("warns without failing when Git is not installed", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const io_ = io();

    await expect(
      run([target], io_, fakeGit({ status: null, errorCode: "ENOENT" }).runner),
    ).resolves.toBe(0);
    // The project itself was generated; only the Git step was skipped.
    expect(io_.logs.join("\n")).toContain("no Git executable was found on PATH");
    expect(existsSync(path.join(target, "package.json"))).toBe(true);
  });

  it("warns without failing when git init exits nonzero", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my-game");
    const io_ = io();

    await expect(
      run([target], io_, fakeGit({ status: 128, stderr: "fatal: cannot mkdir" }).runner),
    ).resolves.toBe(0);
    const log = io_.logs.join("\n");
    expect(log).toContain("Git initialization failed");
    expect(log).toContain("fatal: cannot mkdir");
    // Generated files remain after a Git failure.
    expect(existsSync(path.join(target, "package.json"))).toBe(true);
  });

  it("passes destination paths containing spaces to Git unchanged", async () => {
    const dir = await scratch();
    const target = path.join(dir, "my game dir!");
    const fake = fakeGit();

    await expect(run([target, "--name", "my-game"], io(), fake.runner)).resolves.toBe(0);
    expect(fake.calls).toEqual([{ args: ["init"], cwd: target }]);
  });

  const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!gitAvailable)(
    "scaffolds a working local Git repository (no remote, no commit)",
    async () => {
      const dir = await scratch();
      const target = path.join(dir, "my-game");
      const io_ = io();

      await expect(run([target], io_)).resolves.toBe(0);
      expect(existsSync(path.join(target, ".git"))).toBe(true);

      const git = (args: string[]) => spawnSync("git", args, { cwd: target, encoding: "utf8" });
      // `git status` works in the generated project.
      expect(git(["status", "--porcelain"]).status).toBe(0);
      // Nothing was committed and no remote was configured.
      expect(git(["rev-parse", "HEAD"]).status).not.toBe(0);
      expect(git(["remote"]).stdout?.trim()).toBe("");
    },
  );
});
