# Release guide (R10)

How g2w packages are versioned, rehearsed, and — eventually — published. This
guide is the authority for the release process; the README stays concise and
links here.

**Current status (R10 Phase 2):** the release _infrastructure_ is in place and
rehearsed. **Nothing has ever been published.** No tag exists. The `@g2w/*`
packages and `create-g2w` are not on npm. Publishing additionally requires the
manual npm/GitHub setup in [One-time setup](#one-time-setup), which has not
been performed.

## Package inventory and release order

Eight packages are publishable. Release order is dependency order — a package
is published only after everything it depends on is on the registry:

| #   | Package              | Depends on                     | Notes                            |
| --- | -------------------- | ------------------------------ | -------------------------------- |
| 1   | `@g2w/core`          | — (zero runtime dependencies)  | foundation; always first         |
| 2   | `@g2w/runtime`       | `@g2w/core`, `effect` 4.0.6    | exact-pinned `effect`            |
| 3   | `@g2w/renderer-pixi` | `@g2w/core`, peer `pixi.js>=8` |                                  |
| 4   | `@g2w/input-dom`     | `@g2w/core`                    |                                  |
| 5   | `@g2w/input-gamepad` | `@g2w/core`                    |                                  |
| 6   | `@g2w/audio-web`     | `@g2w/core`                    |                                  |
| 7   | `@g2w/devtools`      | `@g2w/core`                    |                                  |
| 8   | `create-g2w`         | — (dev tool, no g2w imports)   | last; its template pins `@g2w/*` |

`@g2w/example-hello-world` is **private** and never published. The order is
mechanically enforced by the audit in `scripts/validate-packages.mjs` and the
workflow's publish steps.

## Versioning policy: fixed-version monorepo

All eight packages **share one version** and move together. Rationale, from
the actual dependency graph: every runtime package depends on `@g2w/core`, the
packages are currently aligned at `0.1.0`, and the framework is pre-1.0 where
independent versioning would communicate precision the release process does
not have. If a package later becomes truly independent (it never imports
another `@g2w/*` package), that decision can be revisited explicitly.
- **Single source of truth:** the `version` field of every manifest. There is
  no separate root version file; consistency is enforced mechanically by
  `pnpm release:rehearsal` (fails if the eight manifests disagree) and by the
  release workflow's version check. Do not bypass it.
- **Internal dependency constraints:** in-repo manifests use `workspace:*`,
  which pnpm rewrites to the **exact** current version at pack time
  (verified by Phase 1's tarball audit). Published packages therefore pin
  their `@g2w/*` dependencies exactly — which is what the fixed-version
  policy requires. Keep using `workspace:*` internally.
- **Template alignment:** `packages/create-g2w/template/package.json` pins
  every `@g2w/*` dependency at the release version (exact). A version bump
  commit must update the template **and** the pinned-version guard in
  `packages/create-g2w/test/cli.test.ts` (it asserts the exact strings).
- **Bumping:** bump all eight manifests, the template pin, and the
  version-guard test in one commit named `release: vX.Y.Z`. `pnpm -r --filter
  "./packages/*" exec npm version X.Y.Z --no-git-tag-version` updates the
  manifests; the template and test are updated by hand in the same commit.
  Never bump "to make the workflow pass" — a bump is a release decision.
- **Prereleases:** `X.Y.Z-beta.N`, published to the `next` dist-tag
  (`npm publish --tag next`), never to `latest`. Stable releases go to
  `latest`. The rehearsal report prints the planned dist-tag.
- **Published versions are immutable.** npm will reject a re-publish of
  `X.Y.Z`; never attempt to overwrite or unpublish one. A broken release is
  fixed by a follow-up `X.Y.(Z+1)` release.

## Changelog and release notes

Every release commit adds a `CHANGELOG.md` entry (kept at the repository
root, added at the first real release) listing: version, date, packages
released, notable changes, and any breaking changes. GitHub release notes are
generated from that entry. A release without a changelog entry is not ready.

## Release checklist (per release)

1. `pnpm release:rehearsal` passes locally (includes `pnpm test:pack`).
2. Version bumped per the policy above; changelog entry written.
3. All gates green on the release commit (`pnpm check`, `typecheck`,
   `build`, `verify:exports`, `test`, `build:example`, `git diff --check`).
4. Commit and push the release commit to `main`; CI must be green.
5. Dispatch **Release** with `version` = the release version,
   `dry_run` = **true** (default). The `validate` job runs every gate plus
   the packability and rehearsal audits on the exact ref.
6. Only after the validate job is green **and** a maintainer explicitly
   approves: dispatch again with `dry_run` = false and `confirm` = version.
   The `npm-release` environment's required reviewers are the human gate.
7. Verify the release: `npm view @g2w/core version`, install the published
   `create-g2w` in a scratch directory and run `pnpm create g2w`, then tag
   `vX.Y.Z` and create the GitHub release with the changelog entry.

### Partial publishing failure and recovery

If `npm publish` fails partway (the order above matters — `@g2w/core` first,
`create-g2w` last):
1. Do **not** retry the same version if some packages already published:
   published versions are immutable and a partial set at `X.Y.Z` must be
   completed at `X.Y.Z`, not republished from scratch.
2. Identify which packages landed: `npm view <pkg> versions`.
3. Publish the missing packages **in order** (manually with the same flags,
   or re-dispatch with `dry_run=false` — npm skips already-published versions
   with `ETARGET`/`EPUBLISHCONFLICT` and the remaining ones publish; if npm
   hard-fails the rerun instead, publish the missing ones manually).
4. If the registry is left inconsistent (e.g. `create-g2w@X.Y.Z` exists while
   `@g2w/core@X.Y.Z` does not), the follow-up `X.Y.(Z+1)` release repairs it;
   document the incident in the changelog.

### Manual publish fallback

When the workflow's publish job cannot complete (e.g. Trusted Publisher not
yet configured for a package, or npm rejects a brand-new package name with
E404), the maintainer can publish by hand:
1. `npm login` locally (browser-based, 2FA; no tokens are stored in the repo).
2. `pnpm -r pack --pack-destination packed`
3. Publish the tarballs in the documented order — the **`./` prefix is
   required**: without it npm parses `packed/g2w-core-0.1.0.tgz` as the
   `user/repo` GitHub shorthand and fails with a git error.
   `npm publish "./packed/g2w-core-X.Y.Z.tgz" --access public` (and so on).
4. Verify each package: `npm view <name> version`. Registry propagation can
   take a few minutes per package.
5. Delete the `packed/` directory afterwards; it is a build artifact.

This is how the 0.1.0 first release reached the registry.

## One-time setup (complete — the 0.1.0 release is published)

All npm-side prerequisites are done and proven by the published 0.1.0 release
(2026-10-28). History worth knowing for future debugging:
1. **npm account** — `alexander110` (owner `Alexander Agung Raya`, the same
   person as the GitHub account `AlexanderDev2004`; npm username and GitHub
   username do not need to match), 2FA-enabled. The `@g2w` scope is backed by
   the npm **organization `g2w`** (unlimited public, created 2026-10-28).
2. **First release was published manually** — on 2026-10-28 the maintainer
   ran `npm login` locally and published the eight packed tarballs in the
   documented order with `npm publish ./packed/<tarball> --access public`.
   The workflow path was proven up to the registry write (validate job,
   gates, environment approval, OIDC acceptance, provenance signing) but npm
   rejected creating the brand-new names with E404, so the workflow could not
   create them. Publishing each package once manually resolved it.
3. **Trusted Publisher per package — still to configure** — now that the
   packages exist, open each package's npmjs.com Settings page and configure
   the Trusted Publisher: repository `AlexanderDev2004/g2w`, workflow
   filename `release.yml`, environment `npm-release`. Until this is done for
   a package, releases of that package fall back to the manual publish path
   (see "Manual publish fallback" below). npm then accepts publishes whose
   OIDC token matches that identity — **no npm token is ever created or
   stored.**
4. **GitHub environment** — done (2026-10-28): the `npm-release` environment
   exists with required reviewer `AlexanderDev2004` and a custom deployment
   branch policy allowing only `main`; the workflow also gates the publish
   job on `github.ref == 'refs/heads/main'`.

### OIDC vs provenance vs publishing (not interchangeable)

- **OIDC authentication** — GitHub mints a short-lived token; npm validates
  it against the Trusted Publisher config. This _authenticates_ the publish.
- **Provenance attestation** — `npm publish --provenance` attaches a signed
  statement (source repo, commit, workflow) to the published package, built
  from the same OIDC identity. It proves _where a package was built_.
- **Publishing** — the act of uploading to the registry. A publish can happen
  without provenance; provenance without publish is meaningless.

This workflow uses OIDC for auth and always publishes with `--provenance`.

## Security boundaries (enforced, not aspirational)

- `release.yml` triggers **only** on `workflow_dispatch`. Ordinary CI
  (`ci.yml`) runs on push/PR and can never publish; it has no `id-token`
  permission and no registry access.
- The publish job requires: `dry_run=false` **and** `confirm` re-typed to
  exactly match `version` **and** green validation **and** the protected
  `npm-release` environment's reviewer approval. A mis-typed or missing
  confirm input yields a rehearsal, never a publish.
- No `pull_request_target` anywhere. No npm token exists to leak: no
  `NODE_AUTH_TOKEN`, no `.npmrc` secret; publishing authenticates via OIDC.
- Third-party actions are pinned to full commit SHAs with version comments.
- Job permissions are least-privilege: `contents: read` everywhere, plus
  `id-token: write` only on the publish job.
