// ABOUTME: Offline fixture coverage for conservative campaign trace autopsies.
// ABOUTME: Exercises every supported signature, ambiguity guards, storage loading, and redaction.

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type {
  Artifact,
  JsonObject,
  Run,
  RunId,
  TraceEvent,
} from "../../src/shared/types.js";
import { saveArtifact } from "../../src/storage/artifacts.js";
import { saveTraceEvents } from "../../src/storage/events.js";
import { saveRun } from "../../src/storage/runs.js";
import type { StructuralSignatureKind } from "./model.js";
import {
  analyzeAutopsy,
  analyzeStructuralSignatures,
  persistRunAutopsy,
} from "./autopsy.js";

const RUN_ID = "run_autopsy-fixture" as RunId;
const GENERATED_AT = "2026-07-17T12:00:00.000Z";
const EMPTY_PAGE: JsonObject = {
  headings: [],
  forms: 0,
  buttons: 0,
  dialogs: 0,
  tables: 0,
  links: 0,
  inputs: 0,
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wire-autopsy-test-"));
  temporaryRoots.push(root);
  return root;
}

function event(
  id: string,
  kind: TraceEvent["kind"],
  payload: JsonObject,
  second: number,
): TraceEvent {
  return {
    id: `event_${id}` as TraceEvent["id"],
    runId: RUN_ID,
    ts: `2026-07-17T12:00:${String(second).padStart(2, "0")}.000Z`,
    kind,
    payload,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    taskId: "task_autopsy-fixture" as Run["taskId"],
    status: "failed",
    ...overrides,
  };
}

function signatureKinds(
  events: readonly TraceEvent[],
  options: { run?: Run; judgeSuccess?: boolean | null; traceAvailable?: boolean } = {},
): StructuralSignatureKind[] {
  return analyzeStructuralSignatures(events, options).map((signature) => signature.kind);
}

function fixtureAutopsy(
  events: readonly TraceEvent[],
  options: {
    run?: Run;
    judgeSuccess?: boolean | null;
    artifacts?: readonly Artifact[];
    artifactRoot?: string;
  } = {},
) {
  return analyzeAutopsy({
    campaignId: "campaign-autopsy",
    runId: RUN_ID,
    attemptSlotId: "slot-1",
    arm: "candidate",
    ...(options.run ? { run: options.run } : {}),
    events,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
    judgeSuccess: options.judgeSuccess ?? null,
    generatedAt: GENERATED_AT,
  });
}

function assertHashedHttpUrl(value: string | undefined, pathDepth: number): void {
  assert.match(
    value ?? "",
    new RegExp(`^https://host-[a-f0-9]{12}/\\[${pathDepth}-segment-path\\]$`, "u"),
  );
}

test("nav-404 requires an explicit post-navigation not-found observation", () => {
  const events = [
    event("nav-code", "code-exec", { code: "window.location.href = '/missing'" }, 1),
    event("nav-result", "code-result", { ok: true, returnValue: { navigated: true } }, 2),
    event("not-found", "observation", {
      url: "https://example.test/missing",
      title: "404 Not Found | Example",
      pageSummary: EMPTY_PAGE,
    }, 3),
  ];

  const autopsy = fixtureAutopsy(events);
  assert.deepEqual(signatureKinds(events), ["nav-404"]);
  assert.deepEqual(autopsy.signatures[0]?.evidenceEventIds, ["event_nav-result", "event_not-found"]);
});

test("navigation-only-stall requires repeated acknowledgements and no extraction", () => {
  const events = [
    event("nav-one", "code-result", { ok: true, returnValue: { navigatedTo: "https://example.test/a" } }, 1),
    event("nav-two", "code-result", { ok: true, returnValue: { navigatedTo: "https://example.test/b" } }, 2),
  ];
  assert.deepEqual(signatureKinds(events), ["navigation-only-stall"]);

  const withExtraction = [
    ...events,
    event("answer", "code-result", { ok: true, returnValue: { answer: "supported value" } }, 3),
  ];
  assert.deepEqual(signatureKinds(withExtraction), []);
});

test("empty-extraction requires an explicit extraction action and semantically empty success", () => {
  const events = [
    event("extract", "code-exec", { code: "/* wire:extract */ return { rows: [] }" }, 1),
    event("empty", "code-result", { ok: true, returnValue: { rows: [], note: "  " } }, 2),
  ];
  assert.deepEqual(signatureKinds(events), ["empty-extraction"]);

  const ambiguous = [
    event("probe", "code-exec", { code: "return maybeValue" }, 1),
    event("probe-empty", "code-result", { ok: true, returnValue: {} }, 2),
  ];
  assert.deepEqual(signatureKinds(ambiguous), []);
});

test("repeated-action-stall requires stable observations and stable or no-progress results", () => {
  const events: TraceEvent[] = [];
  for (let index = 0; index < 3; index++) {
    events.push(
      event(`poll-${index}`, "code-exec", { code: "return window.app.status" }, index * 3 + 1),
      event(`poll-result-${index}`, "code-result", { ok: true, returnValue: { ready: false } }, index * 3 + 2),
      event(`poll-observation-${index}`, "observation", {
        url: "https://example.test/status",
        title: "Status",
        pageSummary: { ...EMPTY_PAGE, headings: ["Status"] },
      }, index * 3 + 3),
    );
  }

  assert.deepEqual(signatureKinds(events), ["repeated-action-stall"]);
});

test("changing poll results remain unclassified even when action and page shape repeat", () => {
  const events: TraceEvent[] = [];
  for (let index = 0; index < 3; index++) {
    events.push(
      event(`changing-${index}`, "code-exec", { code: "return window.app.status" }, index * 3 + 1),
      event(`changing-result-${index}`, "code-result", { ok: true, returnValue: { progress: index } }, index * 3 + 2),
      event(`changing-observation-${index}`, "observation", {
        url: "https://example.test/status",
        title: "Status",
        pageSummary: { ...EMPTY_PAGE, headings: ["Status"] },
      }, index * 3 + 3),
    );
  }

  assert.deepEqual(signatureKinds(events), []);
});

test("auth-or-antibot accepts explicit persisted auth-wall evidence", () => {
  const events = [
    event("login", "observation", {
      url: "https://example.test/login",
      title: "Sign in",
      pageSummary: { ...EMPTY_PAGE, headings: ["Sign in"] },
    }, 1),
    event("auth-wall", "thought-summary", {
      kind: "auth-wall-detected",
      reason: "Auth wall detected; do not enter credentials.",
    }, 2),
  ];
  assert.deepEqual(signatureKinds(events), ["auth-or-antibot"]);

  const recovered = event("recovered", "observation", {
    url: "https://example.test/article",
    title: "Article",
    pageSummary: { ...EMPTY_PAGE, headings: ["Article"] },
  }, 3);
  assert.deepEqual(signatureKinds([...events, recovered]), []);
});

test("reconfigured-without-content requires a real reconfigure and only empty observations after it", () => {
  const reconfigure = event("reconfigure", "thought-summary", {
    kind: "reconfigure",
    summary: "Enable proxy",
    oldSessionId: "session_old",
    newSessionId: "session_new",
  }, 1);
  const empty = event("blank", "observation", { url: "about:blank", title: "" }, 2);
  assert.deepEqual(signatureKinds([reconfigure, empty]), ["reconfigured-without-content"]);

  const content = event("content", "observation", {
    url: "https://example.test/article",
    title: "Article",
    pageSummary: { ...EMPTY_PAGE, headings: ["Article"], links: 4 },
  }, 3);
  assert.deepEqual(signatureKinds([reconfigure, empty, content]), []);
});

test("runtime-or-network-error requires an explicit error or failed code result", () => {
  const networkError = event("network", "error", {
    code: "ENETWORK",
    message: "fetch failed with ETIMEDOUT",
  }, 1);
  assert.deepEqual(signatureKinds([networkError]), ["runtime-or-network-error"]);

  const failedExec = event("failed-exec", "code-result", {
    ok: false,
    stderr: "Runtime.evaluate failed",
  }, 1);
  assert.deepEqual(signatureKinds([failedExec]), ["runtime-or-network-error"]);
});

test("judge-rejected requires an independently rejected run persisted as succeeded", () => {
  const completion = event("completion", "observation", {
    url: "https://example.test/article",
    title: "Article",
    pageSummary: { ...EMPTY_PAGE, headings: ["Article"] },
  }, 1);
  const completedRun = run({
    status: "succeeded",
    resultProvenance: { artifactIds: [], sourceEventId: completion.id },
  });

  assert.deepEqual(
    signatureKinds([completion], { run: completedRun, judgeSuccess: false }),
    ["judge-rejected"],
  );
  assert.deepEqual(signatureKinds([completion], { run: completedRun, judgeSuccess: true }), []);
  assert.deepEqual(signatureKinds([completion], { run: run(), judgeSuccess: false }), []);
});

test("trace-unavailable is persisted when the attempt WIRE_ROOT has no run trace", async () => {
  const root = await temporaryRoot();
  const outputPath = join(root, "campaign", "autopsies", `${RUN_ID}.json`);
  const autopsy = await persistRunAutopsy({
    campaignId: "campaign-autopsy",
    runId: RUN_ID,
    attemptSlotId: "slot-1",
    arm: "base",
    wireRoot: join(root, "attempt-wire-root"),
    outputPath,
    judgeSuccess: null,
    generatedAt: GENERATED_AT,
  });

  assert.deepEqual(autopsy.signatures.map((signature) => signature.kind), ["trace-unavailable"]);
  assert.deepEqual(autopsy.evidence, []);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), autopsy);
});

test("a normal successful extraction emits no failure signature", () => {
  const events = [
    event("page", "observation", {
      url: "https://example.test/pricing",
      title: "Pricing",
      pageSummary: { ...EMPTY_PAGE, headings: ["Pricing"], tables: 1 },
    }, 1),
    event("extract", "code-exec", { code: "/* wire:extract */ return document.body.innerText" }, 2),
    event("answer", "code-result", { ok: true, returnValue: { plan: "Pro", price: "$20" } }, 3),
  ];
  assert.deepEqual(signatureKinds(events, { run: run({ status: "succeeded" }), judgeSuccess: true }), []);
});

test("ambiguous 404 discussion and unmarked empty probe stay unclassified", () => {
  const events = [
    event("guide", "observation", {
      url: "https://example.test/docs/http-errors",
      title: "Understanding HTTP 404 responses",
      pageSummary: { ...EMPTY_PAGE, headings: ["HTTP status guide"], links: 20 },
    }, 1),
    event("probe", "code-exec", { code: "return maybeValue" }, 2),
    event("empty", "code-result", { ok: true, returnValue: {} }, 3),
  ];
  assert.deepEqual(signatureKinds(events), []);
});

test("evidence persists only generic titles and pseudonymous http URLs", () => {
  const privateTitle = "404 Not Found | Alice Example alice@example.test customer 123-45-6789";
  const events = [
    event("private-nav", "code-exec", { code: "window.location.href = '/missing'" }, 1),
    event("private-result", "code-result", { ok: true, returnValue: { navigated: true } }, 2),
    event("private-observation", "observation", {
      url: "https://alice:private-password@example.test/missing?email=alice@example.test#customer-record",
      title: privateTitle,
      pageSummary: EMPTY_PAGE,
    }, 3),
  ];

  const autopsy = fixtureAutopsy(events);
  const evidence = autopsy.evidence.find((item) => item.eventId === "event_private-observation");
  assertHashedHttpUrl(evidence?.url, 1);
  assert.equal(evidence?.title, "not-found page");
  assert.doesNotMatch(JSON.stringify(autopsy), /Alice|alice@example|123-45-6789|private-password|customer-record|example\.test/u);
});

test("evidence pseudonymizes tenant subdomains while retaining scheme and path depth", () => {
  const events = [
    event("tenant-nav", "code-exec", { code: "window.location.href = '/accounts/missing'" }, 1),
    event("tenant-result", "code-result", { ok: true, returnValue: { navigated: true } }, 2),
    event("tenant-observation", "observation", {
      url: "https://alice-customer.private.example.test/accounts/missing",
      title: "404 Not Found",
      pageSummary: EMPTY_PAGE,
    }, 3),
  ];

  const autopsy = fixtureAutopsy(events);
  const evidence = autopsy.evidence.find((item) => item.eventId === "event_tenant-observation");
  assertHashedHttpUrl(evidence?.url, 2);
  assert.doesNotMatch(JSON.stringify(autopsy), /alice-customer|private\.example|example\.test/u);
});

test("arbitrary error codes containing an email are persisted only as a generic error", () => {
  const autopsy = fixtureAutopsy([event("email-code", "error", {
    code: "alice@example.test",
    message: "runtime failure",
  }, 1)]);
  const evidence = autopsy.evidence.find((item) => item.eventId === "event_email-code");
  assert.equal(evidence?.action, "runtime error");
  assert.doesNotMatch(JSON.stringify(autopsy), /alice@example|example\.test/u);
});

test("tenant-shaped and oversized uppercase error codes fall back to a generic error", () => {
  for (const code of ["EALICE123", `ERR_${"TENANT".repeat(80)}`]) {
    const autopsy = fixtureAutopsy([event("private-code", "error", {
      code,
      message: "runtime failure",
    }, 1)]);
    const evidence = autopsy.evidence.find((item) => item.eventId === "event_private-code");
    assert.equal(evidence?.action, "runtime error");
    assert.doesNotMatch(JSON.stringify(autopsy), /ALICE123|TENANTTENANT/u);
  }
});

test("evidence omits about and data URLs instead of persisting raw schemes", () => {
  const aboutEvents = [
    event("reconfigure-private-url", "thought-summary", {
      kind: "reconfigure",
      oldSessionId: "session_old",
      newSessionId: "session_new",
    }, 1),
    event("about-private-url", "observation", {
      url: "about:blank#alice@example.test",
      title: "Alice Example alice@example.test",
    }, 2),
  ];
  const aboutEvidence = fixtureAutopsy(aboutEvents).evidence
    .find((item) => item.eventId === "event_about-private-url");
  assert.equal(aboutEvidence?.url, undefined);
  assert.equal(aboutEvidence?.title, undefined);

  const dataEvents = [event("data-private-url", "observation", {
    url: "data:text/html,<h1>alice@example.test</h1>",
    title: "Sign in | Alice Example alice@example.test",
    pageSummary: { ...EMPTY_PAGE, headings: ["Sign in"] },
  }, 1)];
  const dataAutopsy = fixtureAutopsy(dataEvents);
  const dataEvidence = dataAutopsy.evidence
    .find((item) => item.eventId === "event_data-private-url");
  assert.equal(dataEvidence?.url, undefined);
  assert.equal(dataEvidence?.title, "authentication or anti-bot page");
  assert.doesNotMatch(JSON.stringify(dataAutopsy), /alice@example|Alice Example|data:text/u);
});

test("storage-backed autopsy redacts and bounds evidence without reading artifact content", async () => {
  const root = await temporaryRoot();
  const wireRoot = join(root, "attempt-wire-root");
  const outputPath = join(root, "campaign", "autopsies", `${RUN_ID}.json`);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const screenshotBytes = "RAWSHOTBYTES0123456789abcdefghijklmnopqrstuvwxyz";
  const artifactId = "artifact_secret-fixture" as Artifact["id"];
  const source = event("secret-nav", "code-exec", {
    code: `window.location.href = 'https://example.test/missing?apiKey=${secret}' /* data:image/png;base64,${screenshotBytes} ${"x".repeat(500)} */`,
  }, 1);
  const navResult = event("secret-result", "code-result", {
    ok: true,
    returnValue: { navigated: true },
  }, 2);
  const observation = event("secret-observation", "observation", {
    url: `https://user:${secret}@example.test/missing?apiKey=${secret}&${"q".repeat(500)}`,
    title: `404 Not Found | ${secret}${"t".repeat(300)}`,
    pageSummary: EMPTY_PAGE,
  }, 3);
  const error = event("secret-error", "error", {
    code: "ENETWORK",
    message: `Connection failed with bearer=${secret}${"m".repeat(500)}`,
  }, 4);
  const storedRun = run({
    status: "succeeded",
    result: `private result ${secret}`,
    resultProvenance: { artifactIds: [artifactId], sourceEventId: navResult.id },
  });
  const artifact: Artifact = {
    id: artifactId,
    runId: RUN_ID,
    kind: "screenshot",
    path: `/tmp/${secret}/${"p".repeat(600)}.png`,
    createdAt: GENERATED_AT,
    metadata: {
      screenshotBase64: `raw-image-bytes-${secret}`,
      fullContent: `full page content ${secret}`,
    },
  };

  await saveRun(wireRoot, storedRun);
  await saveTraceEvents(wireRoot, [source, navResult, observation, error]);
  await saveArtifact(wireRoot, artifact);

  const autopsy = await persistRunAutopsy({
    campaignId: "campaign-autopsy",
    runId: RUN_ID,
    attemptSlotId: "slot-1",
    arm: "candidate",
    wireRoot,
    outputPath,
    judgeSuccess: false,
    generatedAt: GENERATED_AT,
  });
  const serialized = await readFile(outputPath, "utf8");

  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.doesNotMatch(serialized, new RegExp(screenshotBytes, "u"));
  assert.doesNotMatch(serialized, /raw-image-bytes|full page content|screenshotBase64|fullContent|metadata/u);
  assert.doesNotMatch(serialized, /user:|apiKey=|bearer=/u);
  assert.equal(autopsy.evidence.find((item) => item.eventId === error.id)?.action, "runtime error: ENETWORK");
  assertHashedHttpUrl(
    autopsy.evidence.find((item) => item.eventId === observation.id)?.url,
    1,
  );
  assert.deepEqual(autopsy.artifactIds, [artifactId]);
  assert.deepEqual(autopsy.artifacts, []);
  assert.ok(autopsy.evidence.every((item) =>
    (item.url?.length ?? 0) <= 300 &&
    (item.title?.length ?? 0) <= 200 &&
    (item.action?.length ?? 0) <= 300
  ));
  assert.ok(autopsy.evidence.length <= 20);
  assert.ok(autopsy.signatures.every((signature) => signature.evidenceEventIds.length <= 10));
});

test("artifact references are verified against WIRE_ROOT and persisted as relative metadata paths", () => {
  const artifactRoot = "/tmp/wire-root-with-operator-name";
  const artifact = {
    id: "artifact_inside" as Artifact["id"],
    runId: RUN_ID,
    kind: "text",
    path: `${artifactRoot}/payload.txt`,
    createdAt: GENERATED_AT,
  } satisfies Artifact;
  const autopsy = fixtureAutopsy([], { artifacts: [artifact], artifactRoot });

  assert.deepEqual(autopsy.artifacts, [{
    id: artifact.id,
    path: "artifacts/artifact_inside.json",
  }]);
  assert.doesNotMatch(JSON.stringify(autopsy), /operator-name/u);
});
