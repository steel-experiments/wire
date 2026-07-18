# Historical note: the overnight optimizer experiment

This document originally described a manual, unbounded overnight loop for
changing Wire and judging live runs. It established useful motivation—measure
real browser behavior, preserve failed experiments, and prefer simple changes—
but its mutable result log, shared checkout, and rollback procedure did not
provide safe provenance or durable handoff between coding-agent turns.

The supported design is now the bounded campaign engine documented in
[`benchmarks/optimize/README.md`](../../benchmarks/optimize/README.md). It keeps
the existing comparison harness and blind judge immutable, evaluates exact
base/candidate commits in isolated worktrees, persists every physical result,
and stops on declared budget or infrastructure boundaries.

Campaign state and immutable comparison output are the source of truth. A
candidate is never merged, pushed, retried, or discarded automatically. A
promotion result is evidence for human review, not merge authority.
