# Contributing

## Repository conventions

- **Keep the core small.** If a behavior can live in a helper, skill, or provider without weakening traceability, keep it out of the runtime core.
- **Preserve domain boundaries.** `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` must remain separate in code and persistence.
- **Prefer built-in platform capabilities** and narrow interfaces over new dependencies.
- **Use `zod` only at boundaries:** persisted state, provider I/O, skill parsing, and external messages.
- **Keep helpers thin and editable.** Every abstraction needs a direct code path and an escape hatch.
- **Record evidence, not magic.** Avoid hidden retries, opaque healing, and side effects that leave no artifacts or trace data.

## Where behavior belongs

When new knowledge or behavior needs a home, ask:

| If true for... | Then it belongs in... |
|----------------|----------------------|
| One site or task pattern | **skill** — a markdown file in the skills directory |
| Many sites; expressible as a thin callable | **helper** — a thin function in `src/browser/helpers.ts` |
| All sites and tasks; a property of Wire itself | **core** — a module in `src/` |

Treat code size as pressure. Prefer deleting, consolidating, or moving behavior into skills/helpers before growing core.

## Formatting and style

- **ESM imports** with explicit `.js` extensions for compiled local modules
- **Small modules** with named exports
- **Straightforward control flow** and explicit data shapes over indirection
- **Follow `.editorconfig`** for whitespace and line endings
- **`pnpm run typecheck`** as the baseline lint gate

### File headers

Every source file starts with a 2-line comment:

```ts
// ABOUTME: <one-line description of what the file does>
// ABOUTME: <one-line description of key exports or behavior>
```

### Comments

- Write comments only when the **why** is non-obvious
- No multi-paragraph docstrings or multi-line comment blocks (one short line max)
- Comments should be evergreen — describe the code as it is, not how it evolved
- Never refer to temporal context (refactors, recent changes) in comments

## Testing

- **TDD:** write tests before implementation, only enough code to pass, refactor continuously
- **Tests must cover the functionality being implemented**
- Test output must be pristine — capture and assert on error logs, don't ignore them
- **No mock implementations** — use real data and real APIs
- Run with `pnpm test` (uses Node.js built-in test runner)

### Test files

Test files are co-located with source: `src/**/*.test.ts`. The test runner discovers them via glob pattern.

## Dependencies

- **Aim for zero dependencies.** Allow only deliberate high-value exceptions.
- Current dependency: `zod` (boundary validation only)
- Prefer Steel/native platform capabilities over packages.

## Code size

- Source is capped at 12,000 lines (`src/`)
- Update `METRICS.md` with the current LOC count on every code change
- If a file grows large, a module mixes domains, or a helper becomes a DSL, pause and simplify

## Development commands

| Command | What it does |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run via tsx |
| `pnpm build` | Compile to `dist/` |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm check` | typecheck + test |

## Technical requirements

- Node.js 22+
- TypeScript strict mode
- ESM only
- pnpm for package management
