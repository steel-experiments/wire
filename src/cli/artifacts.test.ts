import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { persistTraceArtifacts } from "./artifacts.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { TraceEvent } from "../shared/types.js";

test("persistTraceArtifacts decodes base64 screenshot artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-artifacts-"));
  const runId = createId("run");
  const artifactId = createId("artifact");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const event: TraceEvent = {
    id: createId("event"),
    runId,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "screenshot",
      mimeType: "image/png",
      path: `artifacts/${artifactId}.png`,
      contentBase64: bytes.toString("base64"),
      metadata: {
        source: "step-screenshot",
        step: 1,
      },
    },
  };

  try {
    const artifacts = await persistTraceArtifacts(root, [event]);

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.kind, "screenshot");
    assert.equal(artifacts[0]!.mimeType, "image/png");
    assert.equal(artifacts[0]!.metadata?.source, "step-screenshot");
    assert.equal(artifacts[0]!.metadata?.step, 1);
    assert.equal(artifacts[0]!.metadata?.contentEncoding, "base64");
    assert.equal(artifacts[0]!.metadata?.contentSize, bytes.byteLength);
    assert.deepEqual(await readFile(join(root, `artifacts/${artifactId}.png`)), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
