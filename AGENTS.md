# Repository Guidelines

## Project Structure & Module Organization

This repository provides a Node.js GitHub Action that creates immutable Quadraticc builds. `src/main.ts` is the entry point; `src/action.ts` handles Actions inputs and outputs, `src/build.ts` validates metadata and build responses, and `src/http.ts` implements HTTPS transport. `action.yml` declares the public interface.

Tests live in `tests/*.test.mjs`, with shared data in `tests/fixtures.mjs`. TypeScript compiles into ignored `build/`; ncc packages the distributable into committed `dist/`. CI configuration lives in `.github/workflows/check.yml`.

## Build, Test, and Development Commands

Use Node.js 24 or newer and install locked dependencies with `npm ci`.

- `npm run check`: type-check without emitting files.
- `npm run compile`: compile TypeScript into `build/`.
- `npm run build`: compile and bundle the action into `dist/`.
- `npm test`: compile and run the Node.js test runner.
- `node scripts/verify-dist.mjs`: detect changed or untracked distribution files after rebuilding.
- `npm audit --audit-level=moderate`: check dependency vulnerabilities.

Commit the complete rebuilt `dist/`, including `package.json` and `licenses.txt`, whenever source or dependency changes affect the bundle.

## Coding Style & Naming Conventions

Follow existing TypeScript and ES module conventions: two-space indentation, single quotes, semicolons, camelCase functions and variables, and PascalCase interfaces and types. Use `.js` extensions in relative TypeScript imports. Preserve strict typing and `noUncheckedIndexedAccess`. No dedicated formatter or linter is configured; match nearby code and run `npm run check`.

## Testing Guidelines

Use `node:test` and `node:assert/strict`, with descriptive behavior-based test names in `*.test.mjs` files. Cover changed validation, acknowledgement, output, and transport behavior. Use fixtures and local HTTPS servers; tests must not require production credentials. No numeric coverage threshold is configured. Build before testing bundle changes. CI checks Node 24 on Ubuntu, macOS, and Windows.

## Commit & Pull Request Guidelines

The repository has no commits yet, so no established commit-message convention exists. Use concise imperative subjects describing the change. Pull requests should explain behavior changes, link relevant issues, and list validation commands and results. Update `README.md`, `action.yml`, and interface tests together when changing inputs or outputs.

## Security & Configuration

Never commit credentials or environment files. Preserve token masking, HTTPS certificate verification, redirect refusal, bounded requests and responses, and safe errors that omit credentials and provider response bodies. Build creation must not automatically retry ambiguous failures.
