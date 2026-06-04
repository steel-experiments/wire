import type { JsonObject } from "../../../shared/types.js";
import { CdpConnection, evaluateJson } from "./cdp.js";
import type { WireClickPolicyDecision, WireClickRequest } from "./types.js";

const WIRE_CLICK_BINDING_NAME = "__wire_action";

const WIRE_CLICK_SHIM = `(() => {
  if (window.wire && window.wire.__wireClickReady === true) return;
  const pending = new Map();
  let nextId = 1;

  function selectorHint(el) {
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return "#" + CSS.escape(el.id);
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";
    const role = el.getAttribute("role");
    if (role) return el.tagName.toLowerCase() + "[role=" + JSON.stringify(role) + "]";
    return el.tagName.toLowerCase();
  }

  function resolveTarget(target) {
    if (typeof target === "string") {
      const found = document.querySelector(target);
      if (!found) throw new Error("wire.click: no element for selector " + target);
      return found;
    }
    if (target && target.nodeType === 1) return target;
    throw new Error("wire.click: expected Element or selector string");
  }

  function frameOffset(el) {
    let x = 0;
    let y = 0;
    let doc = el.ownerDocument;
    while (doc && doc.defaultView && doc.defaultView.frameElement) {
      const frame = doc.defaultView.frameElement;
      const rect = frame.getBoundingClientRect();
      x += rect.left;
      y += rect.top;
      doc = frame.ownerDocument;
    }
    return { x, y };
  }

  function snapshotTarget(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error("wire.click: target has no visible box");
    }
    const offset = frameOffset(el);
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    return {
      x: offset.x + rect.left + rect.width / 2,
      y: offset.y + rect.top + rect.height / 2,
      target: {
        tag: el.tagName ? el.tagName.toLowerCase() : undefined,
        role: el.getAttribute("role") || undefined,
        text: text || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
        selectorHint: selectorHint(el),
      },
    };
  }

  window.__wire_resolve = function(id, ok, value) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(value && value.error ? value.error : String(value || "wire action failed")));
  };

  window.wire = {
    __wireClickReady: true,
    click(target, opts) {
      const el = resolveTarget(target);
      const snap = snapshotTarget(el);
      const id = String(nextId++);
      const payload = {
        id,
        kind: "click",
        x: snap.x,
        y: snap.y,
        button: opts && opts.button,
        target: snap.target,
      };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.__wire_action(JSON.stringify(payload));
      });
    },
  };
})()`;

export async function installWireClickBinding(
  cdp: CdpConnection,
  sessionId: string,
  wireEvents: JsonObject[],
  policy: (request: WireClickRequest) => WireClickPolicyDecision,
): Promise<void> {
  cdp.on("Runtime.bindingCalled", async (params) => {
    if (!params || typeof params !== "object") return;
    const event = params as Record<string, unknown>;
    if (event["__sessionId"] !== undefined && event["__sessionId"] !== sessionId) return;
    if (event["name"] !== WIRE_CLICK_BINDING_NAME || typeof event["payload"] !== "string") return;

    let request: WireClickRequest | undefined;
    let dispatched = false;
    try {
      const parsed = JSON.parse(event["payload"]) as unknown;
      request = parseWireClickRequest(parsed);
      const decision = policy(request);
      if (decision.result !== "allow") {
        const reason = decision.reason ? `: ${decision.reason}` : "";
        throw new Error(`wire.click ${decision.result}${reason}`);
      }
      await dispatchWireClick(cdp, sessionId, request);
      dispatched = true;
      wireEvents.push(wireClickEvent(request, true));
      await resolveWireAction(cdp, sessionId, request.id, true, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (request && !dispatched) {
        wireEvents.push(wireClickEvent(request, false, message));
        await resolveWireAction(cdp, sessionId, request.id, false, { error: message });
      }
    }
  });
  try {
    await cdp.send("Runtime.removeBinding", { name: WIRE_CLICK_BINDING_NAME }, sessionId);
  } catch {
    // Older contexts or first install may have nothing to remove.
  }
  await cdp.send("Runtime.addBinding", { name: WIRE_CLICK_BINDING_NAME }, sessionId);
  await evaluateJson<unknown>(cdp, sessionId, WIRE_CLICK_SHIM);
}

const WIRE_CLICK_DENY_PATTERNS = [
  /\b(delete|remove|destroy|purge|drop|truncate)\b/iu,
];

const WIRE_CLICK_APPROVAL_PATTERNS = [
  /\b(pay|purchase|checkout|buy|order|submit|confirm|send|post|reply|email|invite)\b/iu,
  /\b(billing|account|password|permission|role|grant|revoke|transfer)\b/iu,
];

export function defaultWireClickPolicy(request: WireClickRequest): WireClickPolicyDecision {
  const target = request.target;
  const text = [
    target?.text,
    target?.ariaLabel,
    target?.role,
    target?.selectorHint,
  ].filter((item): item is string => typeof item === "string" && item.length > 0).join(" ");

  if (WIRE_CLICK_DENY_PATTERNS.some((pattern) => pattern.test(text))) {
    return { result: "deny", reason: "destructive click target" };
  }

  if (WIRE_CLICK_APPROVAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { result: "require-approval", reason: "sensitive click target" };
  }

  return { result: "allow" };
}

function parseWireClickRequest(value: unknown): WireClickRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("wire.click: malformed binding payload");
  }
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "click") {
    throw new Error("wire.click: unsupported wire action");
  }
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error("wire.click: missing request id");
  }
  if (typeof record["x"] !== "number" || typeof record["y"] !== "number") {
    throw new Error("wire.click: missing viewport coordinates");
  }
  const button = record["button"];
  if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") {
    throw new Error("wire.click: unsupported button");
  }
  const request: WireClickRequest = {
    id: record["id"],
    kind: "click",
    x: record["x"],
    y: record["y"],
    ...(button ? { button } : {}),
  };
  const target = sanitizeWireTarget(record["target"]);
  if (target) request.target = target;
  return request;
}

function sanitizeWireTarget(value: unknown): WireClickRequest["target"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const target: NonNullable<WireClickRequest["target"]> = {};
  for (const key of ["tag", "role", "text", "ariaLabel", "selectorHint"] as const) {
    const item = record[key];
    if (typeof item === "string" && item.length > 0) {
      target[key] = item.slice(0, 160);
    }
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

async function dispatchWireClick(cdp: CdpConnection, sessionId: string, request: WireClickRequest): Promise<void> {
  const button = request.button ?? "left";
  const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
  const base = { x: request.x, y: request.y };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", button, buttons, clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", button, buttons: 0, clickCount: 1 }, sessionId);
}

async function resolveWireAction(
  cdp: CdpConnection,
  sessionId: string,
  id: string,
  ok: boolean,
  value: Record<string, unknown>,
): Promise<void> {
  const expression = `window.__wire_resolve(${JSON.stringify(id)}, ${ok ? "true" : "false"}, ${JSON.stringify(value)})`;
  await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
}

function wireClickEvent(request: WireClickRequest, ok: boolean, error?: string): JsonObject {
  const event: JsonObject = {
    source: "wireBinding",
    action: "click",
    ok,
    x: request.x,
    y: request.y,
    button: request.button ?? "left",
  };
  if (request.target) event.target = request.target;
  if (error) event.error = error;
  return event;
}
