# Wire

Wire by Steel is the zero-weight browser agent for real web work.

This repository starts with a strict TypeScript, ESM-only, low-dependency skeleton that keeps the core small and the architecture explicit.

## Principles

- Steel carries browser infrastructure; Wire carries intent through it.
- Keep `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` boundaries explicit.
- Prefer platform features and small files over framework weight.
- Use runtime validation only at system boundaries.

## Workspace

- Node.js 22+
- `pnpm` for package management
- `tsx` for local execution
- strict TypeScript
- ESM only

## Commands

- `pnpm install`
- `pnpm dev`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check`
