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

The project is capped at **12,500 lines of code** (`src/`). This is a hard limit that must never be crossed. Before adding code, consider what can be removed or consolidated first. If a change would push the total past 12.5k LOC, stop and propose deletions to make room. The cap was raised from 12,000 once the foundation was complete (live trace UI, layered stuck-loop guards, full skill lifecycle, .env loading, repeat-detector metacognition); future bumps should be similarly justified by structural milestones, not feature accretion.
