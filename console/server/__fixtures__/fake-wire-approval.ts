// ABOUTME: Test fixture for the approval flow. As `run` it stops at an approval
// ABOUTME: gate; as `approve` it resumes, finishes, and writes the run record.

import { join } from "node:path";

const argv = process.argv.slice(2);
const isApprove = argv.includes("approve");
const runId = "run_appr_test";
const ts = "2026-06-16T00:00:00.000Z";

const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (!isApprove) {
  emit({ id: "a0", runId, ts, kind: "session", payload: { sessionId: "s_appr", liveUrl: "https://app.steel.dev/v/appr" } });
  emit({ id: "a1", runId, ts, kind: "observation", payload: { url: "https://shop.example.com", title: "Checkout" } });
  emit({
    id: "a2",
    runId,
    ts,
    kind: "approval-request",
    payload: {
      approvalId: "appr_1",
      summary: "Submit the purchase order",
      proposedAction: { kind: "exec", riskKind: "purchase", codeExcerpt: "document.querySelector('#buy').click()" },
    },
  });
  // Exit without a finalized record — the run is paused at the gate.
} else {
  emit({ id: "b1", runId, ts, kind: "approval-result", payload: { approvalId: "appr_1", result: "approved" } });
  emit({ id: "b2", runId, ts, kind: "code-exec", payload: { code: "document.querySelector('#buy').click()" } });
  emit({ id: "b3", runId, ts, kind: "code-result", payload: { ok: true, durationMs: 10, returnValue: "ordered" } });
  emit({ id: "b4", runId, ts, kind: "thought-summary", payload: { kind: "finish", summary: "Order placed" } });
  if (process.env.WIRE_ROOT) {
    await Bun.write(
      join(process.env.WIRE_ROOT, "runs", `${runId}.json`),
      JSON.stringify({ id: runId, status: "succeeded", result: "ordered", classification: { kind: "task-complete" } }),
    );
  }
}
