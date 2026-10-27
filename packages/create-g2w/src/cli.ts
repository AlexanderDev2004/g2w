#!/usr/bin/env node
/**
 * create-g2w — scaffold a new g2w game project.
 *
 * A zero-dependency Node CLI (Node >= 22): it copies the bundled template
 * directory into the destination, substituting the project name. It never
 * prompts and never deletes user files; its only subprocess is a local
 * `git init` in the freshly generated directory (see {@link defaultGitRunner}).
 * All behavior is in `run()` so the CLI is deterministic and unit-testable.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `create-g2w — scaffold a new g2w game project

Usage:
  pnpm create g2w <target-directory> [options]
  create-g2w <target-directory> [options]

Arguments:
  <target-directory>  Directory to create the project in (created if missing).

Options:
  --name <name>       Package name for the generated project (default: a
                      package-safe form of the target directory's name).
  --force             Write into an existing non-empty directory, overwriting
                      only the files this tool generates. Never deletes any
                      pre-existing file.
  -h, --help          Show this help.

After generation:
  cd <target-directory>
  pnpm install
  pnpm dev

A local Git repository is initialized in the generated project (no remote,
no initial commit). Initialization is skipped with a warning when Git is
not installed or the destination already contains Git metadata.
`;

/** An error with a user-facing message; `run()` reports it and exits 1. */
class ScaffoldError extends Error {}

/** A template variable the generator substitutes in copied files. */
const PROJECT_NAME_VARIABLE = "{{PROJECT_NAME}}";

/** Template files copied verbatim; nothing else is written. */
const TEMPLATE_DIR = fileURLToPath(new URL("../template/", import.meta.url));

/** Characters allowed in an npm package name (scoped names not needed). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface RunIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

interface Options {
  destination: string;
  projectName: string;
  force: boolean;
}

/**
 * Turns a directory name into a package-safe project name. Returns null when
 * no reasonable name can be derived and the caller should pass --name.
 */
export function sanitizeProjectName(raw: string): string | null {
  const lowered = raw.trim().toLowerCase().replaceAll(" ", "-");
  return NAME_PATTERN.test(lowered) ? lowered : null;
}

function parseOptions(argv: string[]): Options {
  let destination: string | undefined;
  let projectName: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      throw new HelpRequested();
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--name") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ScaffoldError("--name requires a value, e.g. --name my-game.");
      }
      projectName = value;
      i++;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new ScaffoldError(`Unknown option: ${argument}. Run create-g2w --help for usage.`);
    }
    if (destination !== undefined) {
      throw new ScaffoldError(
        `Unexpected extra argument: ${argument}. Pass exactly one target directory.`,
      );
    }
    destination = argument;
  }

  if (destination === undefined) {
    throw new ScaffoldError(
      "Missing target directory. Usage: create-g2w <target-directory> [--name <name>] [--force]",
    );
  }

  const resolved = path.resolve(destination);
  const derived = sanitizeProjectName(path.basename(resolved));
  const name = projectName ?? derived;
  if (name === null || !NAME_PATTERN.test(name)) {
    throw new ScaffoldError(
      `Cannot derive a package name from "${path.basename(resolved)}". Pass a valid one with --name <name>.`,
    );
  }

  return { destination: resolved, projectName: name, force };
}

class HelpRequested extends Error {}

/** Outcome of one injected Git invocation. */
export interface GitCommandResult {
  /** Process exit code, or null when the executable could not be spawned. */
  status: number | null;
  /** Spawn-failure code, e.g. "ENOENT" when Git is not installed. */
  errorCode?: string;
  /** Captured stderr, used to explain a nonzero exit to the user. */
  stderr?: string;
}

/**
 * Runs one Git invocation with explicit arguments in the given working
 * directory. Injectable so tests never need a real Git installation.
 */
export type GitRunner = (args: string[], cwd: string) => GitCommandResult;

/**
 * The real Git runner: an explicit argv array (the destination is the `cwd`,
 * never part of a command string) with no shell, so no user-controlled path
 * or project name is ever interpolated into a shell command.
 */
function defaultGitRunner(args: string[], cwd: string): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    ...(result.error === undefined
      ? {}
      : { errorCode: "code" in result.error ? String(result.error.code) : undefined }),
    ...(result.stderr === undefined || result.stderr === "" ? {} : { stderr: result.stderr }),
  };
}

/** Walks the template tree up-front and returns sorted relative file paths. */
async function listTemplateFiles(): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(path.relative(TEMPLATE_DIR, entryPath));
      }
    }
  }
  await walk(TEMPLATE_DIR);
  return files.sort();
}

/**
 * Scaffolds a project. Throws ScaffoldError on any expected failure
 * (invalid arguments, unsafe destination, missing template file).
 */
export async function run(
  argv: string[],
  io: RunIO,
  git: GitRunner = defaultGitRunner,
): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.log(USAGE);
      return 0;
    }
    throw error;
  }
  const { destination, projectName, force } = options;

  let destinationStat = null;
  try {
    destinationStat = await stat(destination);
  } catch {
    // Missing destination is the normal case: it is created below.
  }
  if (destinationStat !== null && !destinationStat.isDirectory()) {
    throw new ScaffoldError(`"${destination}" exists and is not a directory.`);
  }
  if (destinationStat !== null && !force) {
    const existing = await readdir(destination);
    if (existing.length > 0) {
      throw new ScaffoldError(
        `"${destination}" is not empty (${existing.slice(0, 5).join(", ")}${
          existing.length > 5 ? ", …" : ""
        }). Refusing to overwrite user files. Re-run with --force to write into it anyway.`,
      );
    }
  }

  const templateFiles = await listTemplateFiles();
  if (templateFiles.length === 0) {
    throw new ScaffoldError(
      `No template files found in "${TEMPLATE_DIR}". The installation is broken.`,
    );
  }

  for (const relative of templateFiles) {
    const source = path.join(TEMPLATE_DIR, relative);
    const target = path.join(destination, relative);
    const contents = await readFile(source, "utf8");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents.replaceAll(PROJECT_NAME_VARIABLE, projectName));
  }

  await initializeGitRepository(destination, git, io);

  io.log(`Created a g2w project in ${destination} (package name: ${projectName}).`);
  io.log("");
  io.log("Next steps:");
  io.log(`  cd ${path.relative(process.cwd(), destination) || "."}`);
  io.log("  pnpm install");
  io.log("  pnpm dev");
  io.log("");
  io.log("Then open the printed localhost URL. Controls: WASD / arrow keys.");
  return 0;
}

/**
 * Initializes a local Git repository in a freshly generated project: plain
 * `git init` in the destination — never a remote, an initial commit, or a
 * push, and never a shell command string. Every failure mode (Git missing,
 * nonzero exit) is a warning: the project itself was generated successfully,
 * so scaffolding still exits 0. An existing `.git` (directory or worktree
 * file) is left untouched and reported as skipped.
 */
async function initializeGitRepository(
  destination: string,
  git: GitRunner,
  io: RunIO,
): Promise<void> {
  let gitMetadataStat = null;
  try {
    gitMetadataStat = await stat(path.join(destination, ".git"));
  } catch {
    // No Git metadata: the normal case for a fresh project.
  }
  if (gitMetadataStat !== null) {
    io.log(
      "Skipped Git initialization: the destination already contains Git metadata, which was left untouched.",
    );
    return;
  }
  const result = git(["init"], destination);
  if (result.errorCode === "ENOENT") {
    io.log(
      'Generated the project, but skipped Git initialization: no Git executable was found on PATH. Install Git and run "git init" in the project directory.',
    );
    return;
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    io.log(
      `Generated the project, but Git initialization failed (exit ${result.status ?? "unknown"}).${
        detail === undefined || detail === "" ? "" : ` Git said: ${detail}`
      } Run "git init" in the project directory to retry manually.`,
    );
    return;
  }
  io.log("Initialized an empty Git repository in the project (no remote, no initial commit).");
}

/** CLI entry point: runs and maps failures to exit codes. */
export async function main(argv: string[]): Promise<number> {
  const io: RunIO = {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  };
  try {
    return await run(argv, io);
  } catch (error) {
    io.error(`create-g2w: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
