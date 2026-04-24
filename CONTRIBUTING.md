# Contributing

## Repository conventions

- Keep the core small. If a behavior can live in a helper, skill, or provider without weakening traceability, keep it out of the runtime core.
- Preserve domain boundaries. `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` should remain separate in code and persistence.
- Prefer built-in platform capabilities and narrow interfaces over new dependencies.
- Use `zod` only at boundaries: persisted state, provider I/O, skill parsing, and external messages.
- Keep helpers thin and editable. Every abstraction needs a direct code path and an escape hatch.
- Record evidence, not magic. Avoid hidden retries, opaque healing, and side effects that do not leave artifacts or trace data.

## Formatting and style

- Use ESM imports with explicit `.js` extensions when importing compiled local modules.
- Default to small modules with named exports.
- Prefer straightforward control flow and explicit data shapes over indirection.
- Follow `.editorconfig` for whitespace and line endings.
- Use `pnpm run typecheck` as the baseline lint gate until narrower rules are justified by real maintenance cost.
