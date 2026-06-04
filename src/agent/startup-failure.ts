import type { Task } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { contractCreatedPayload } from "./contract.js";
import { createLoopState, finalizeRun, type LoopResult } from "./loop.js";
import type { RuntimeConfig } from "./runtime.js";

export async function createStartupFailureResult(
  task: Task,
  config: RuntimeConfig,
  err: unknown,
): Promise<LoopResult> {
  const loopOptions: Parameters<typeof createLoopState>[3] = {};
  if (config.sessionInput?.sessionConfig) {
    loopOptions.sessionConfig = config.sessionInput.sessionConfig;
  }
  if (config.sessionInput?.profileId) {
    loopOptions.profileId = config.sessionInput.profileId;
  }
  const state = createLoopState(task, createId("session"), undefined, loopOptions);
  const message = err instanceof Error ? err.message : String(err);
  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "contract-check",
      payload: contractCreatedPayload(state.contract),
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "error",
      payload: {
        message,
        code: "ESESSIONSTART",
      },
    },
  );

  if (config.traceSink) {
    for (const event of state.events) {
      await config.traceSink.onEvent?.(event);
    }
  }

  return finalizeRun(state, { stopReason: message });
}
