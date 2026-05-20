# AGENTS.md

`MANIFESTO.md` is the north star; `SPECS.md` is the implementation reference.

Build Wire as a zero-weight browser agent: small core, real browser, code-first actions, evidence-backed runs, thin helpers, explicit policy boundaries, and durable file-based skills.

Aim for zero dependencies; allow only deliberate high-value exceptions like `zod`, and prefer Steel/native platform capabilities over packages.

Use domain-shaped modules with clear boundaries; keep `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` separate in code and behavior.

Apply DRY and KISS aggressively; back behavior with extensive tests and document decisions where future maintainers would otherwise guess.

Do not add framework weight, hidden retries, prompt soup, secret-bearing skills, or clever abstractions without escape hatches.

When in doubt, choose the simplest change that preserves inspectability, traceability, and real-browser behavior.

When new knowledge or behavior needs a home, ask:

- True for one site or task pattern? → **skill**
- True for many sites; expressible as a thin callable function? → **helper**
- True regardless of site or task; a property of how wire itself works? → **core**

Treat code size as pressure, not a quota. Prefer deleting, consolidating, or moving behavior into skills/helpers before growing core.

On every code change, update `METRICS.md` with the current `src/` LOC count.

If a file grows large, a module mixes domains, a helper becomes a workflow DSL, or a feature adds dependency/retry/background weight, pause and simplify or document why the added core complexity is worth it.
