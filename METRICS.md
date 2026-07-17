# Metrics

Project size, tracked per change-day. Update with `pnpm metrics` and record
the end-of-day values here (one row per day; the day's last measurement wins).

Command: `find src -type f \( -name '*.ts' -o -name '*.tsx' \) [! -name '*.test.*'] -print0 | xargs -0 wc -l | tail -1`

| Date | Production LOC | Test LOC |
| --- | ---: | ---: |
| 2026-05-20 | 14940 | 14414 |
| 2026-05-21 | 15315 | 14879 |
| 2026-05-22 | 15419 | 15064 |
| 2026-05-25 | 15689 | 15663 |
| 2026-05-29 | 15632 | 15682 |
| 2026-06-01 | 16076 | 16039 |
| 2026-06-02 | 16297 | 16343 |
| 2026-06-03 | 16353 | 16464 |
| 2026-06-04 | 17264 | 17788 |
| 2026-06-05 | 17270 | 17826 |
| 2026-06-08 | 17726 | 18339 |
| 2026-06-10 | 17894 | 19611 |
| 2026-06-11 | 18506 | 20480 |
| 2026-06-16 | 18562 | 20516 |
| 2026-06-22 | 18584 | 20554 |
| 2026-06-30 | 19685 | 21257 |
| 2026-07-01 | 19741 | 21540 |
| 2026-07-17 | 19751 | 21864 |

## Judge agreement

How often the run classifier's stored verdict matches hand-labeled ground
truth (`benchmarks/judge-labels.json`). Measure with `pnpm build && pnpm
judge:score`; labels are a stratified sample over classification kinds and
score the judge as it ran (mixed classifier versions — refresh the labeled
set as new runs accumulate).

| Date | Agreement | Labeled | Notes |
| --- | ---: | ---: | --- |
| 2026-06-11 | 72.5% (29/40) | 40 (+4 uncertain) | 7 of 11 disagreements were one bug: chrome-error pages classified blocked-auth (fixed in detectAuthWall the same day → 87.9% excluding that class). Remaining: 2 over-credited (task-complete without completion evidence), 1 under-credited, 1 partial-vs-agent-error. |
| 2026-06-11 | 73.8% (31/42) | 42 (+4 uncertain) | Same set + 2 same-day live validation runs (both agreements: a clean task-complete and a guard-bounded search-trap partial). |
