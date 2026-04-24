# AGENTS.md

`MANIFESTO.md` is the north star; `SPECS.md` is the implementation reference.

Build Wire as a zero-weight browser agent: small core, real browser, code-first actions, evidence-backed runs, thin helpers, explicit policy boundaries, and durable file-based skills.

Aim for zero dependencies; allow only deliberate high-value exceptions like `zod`, and prefer Steel/native platform capabilities over packages.

Use domain-shaped modules with clear boundaries; keep `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` separate in code and behavior.

Apply DRY and KISS aggressively; back behavior with extensive tests and document decisions where future maintainers would otherwise guess.

Do not add framework weight, hidden retries, prompt soup, secret-bearing skills, or clever abstractions without escape hatches.

When in doubt, choose the simplest change that preserves inspectability, traceability, and real-browser behavior.
