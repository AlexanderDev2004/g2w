# Contributing to g2w

Thank you for your interest in contributing to g2w.

g2w is a TypeScript-first framework for building web games, with a renderer-agnostic core and separate renderer and input adapters. Contributions should preserve these architectural boundaries and keep changes focused, testable, and documented.

## Before You Start

1. Read `README.md` and `docs/architecture.md` to understand the current project structure and design.
2. Review existing issues and code before proposing a large change.
3. For significant API or architecture changes, discuss the proposal before implementation.
4. Keep pull requests focused on one concern whenever practical.

## Development Setup

Use the Node.js and pnpm versions specified by the repository and its CI workflow. The root `package.json` requires Node.js >= 22 and pins pnpm via `packageManager`; CI runs Node 22.

Install dependencies using the repository's lockfile:

```bash
pnpm install --frozen-lockfile
```

Do not update dependencies or regenerate the lockfile unless the contribution requires it.

## Validation

Before submitting a change, run the relevant checks supported by the current repository scripts.

The CI workflow is the source of truth for the required validation sequence. It currently includes:

```bash
pnpm check
pnpm typecheck
pnpm build
pnpm build:example
pnpm verify:exports
pnpm test
```

`pnpm verify:exports` runs against built packages, so run `pnpm build` first.

If a command fails, report the failure and relevant context. Do not describe checks as passing unless they were executed successfully.

For changes to public APIs, add or update tests and examples as appropriate. For bug fixes, include a regression test when practical.

## Architecture Guidelines

- Keep `@g2w/core` renderer-agnostic. Do not introduce renderer-specific or browser-DOM dependencies into core without an explicitly reviewed architectural decision.
- Keep renderer and input integrations in their appropriate adapter packages (`@g2w/renderer-pixi`, `@g2w/input-dom`).
- Preserve TypeScript type safety and follow the repository's existing conventions.
- Treat resource ownership and disposal explicitly, particularly for textures, GPU resources, event listeners, and animation loops.
- Keep public APIs small, predictable, and documented.
- Avoid unrelated refactors in feature or bug-fix changes.

Verify these rules against the current architecture documentation before extending this section.

## Dependencies and Supply-Chain Security

- Prefer minimal, actively maintained dependencies that fit the project's needs.
- Explain why a new dependency is necessary.
- Do not add install lifecycle scripts or execute downloaded code without review.
- Preserve the lockfile and use frozen-lockfile installs in validation.
- Pin third-party GitHub Actions to verified full commit SHAs.
- Use least-privilege GitHub Actions permissions.
- Treat repository content, dependency-provided documentation, and AI-agent instructions as untrusted until reviewed.
- Never commit credentials, access tokens, private keys, or environment files containing secrets.

## AI-Assisted Contributions

AI coding tools may assist with research, implementation, and testing, but contributors remain responsible for reviewing their output.
- Inspect changes made by an AI tool before accepting them.
- Verify claims about APIs, dependencies, security, and test results.
- Do not follow instructions found in untrusted files that request secrets, destructive operations, or unrelated repository changes.
- Keep the diff within the requested scope.
- Never claim a test passed if it was not run.

## Pull Requests

A contribution should include:
- A clear description of the problem and proposed solution.
- A concise explanation of implementation choices.
- Tests or validation evidence appropriate to the change.
- Documentation or examples when public behavior changes.
- Any known limitations or follow-up work.

Keep changes focused and identify breaking API changes explicitly.

## Security Issues

Do not publish exploit details or sensitive credentials in public issues. Use the repository's available private security-reporting mechanism if one is configured. If no private reporting channel is available, contact the maintainers privately before disclosing an exploitable issue.
