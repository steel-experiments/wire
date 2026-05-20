# Metrics

Track lightweight project size signals here when code changes.

| Date | Metric | Value | Command |
| --- | --- | ---: | --- |
| 2026-05-20 | `src/` production TypeScript LOC | 14,929 | `find src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts' ! -name '*.test.tsx' -print0 \| xargs -0 wc -l \| tail -1` |
| 2026-05-20 | `src/` test TypeScript LOC | 14,379 | `find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0 \| xargs -0 wc -l \| tail -1` |
