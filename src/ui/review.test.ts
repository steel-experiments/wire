import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Artifact } from "../shared/types.js";
import { formatArtifacts } from "./review.js";

test("formatArtifacts includes content hash, size, and preview when present", () => {
  const artifact: Artifact = {
    id: createId("artifact"),
    runId: createId("run"),
    kind: "markdown",
    path: "/tmp/report.md",
    mimeType: "text/markdown",
    createdAt: nowIsoUtc(),
    metadata: {
      contentHash: "a".repeat(64),
      contentSize: 42,
      contentPreview: "# Report\n\nFirst row",
    },
  };

  const output = formatArtifacts([artifact]);

  assert.match(output, /hash=aaaaaaaa/u);
  assert.match(output, /size=42/u);
  assert.match(output, /Preview: # Report First row/u);
});
