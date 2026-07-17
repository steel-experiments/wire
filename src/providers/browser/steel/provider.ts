import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  SessionId,
} from "../../../shared/types.js";
import { BROWSER_LINK_SAMPLE_LIMITS } from "../../../shared/link-samples.js";
import type { BrowserObserveInput, BrowserProvider } from "../../../browser/bridge.js";
import { validateBrowserCode } from "./code-validation.js";
import {
  buildCreateSessionBody,
  DEFAULT_BASE_URL,
  DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  DEFAULT_GET_SESSION_RETRY_DELAY_MS,
  extractSteelId,
  GET_SESSION_MAX_ATTEMPTS,
  SteelApiError,
  steelFetch,
  toBrowserSession,
} from "./api.js";
import {
  attachToTarget,
  capRawRuntimeEvaluate,
  CdpConnection,
  cdpMethodNeedsTargetSession,
  evaluateJson,
  listPageTargets,
  pickExecTargets,
  pickTarget,
  withConnection,
} from "./cdp.js";
import { defaultWireClickPolicy, installWireClickBinding } from "./wire-click.js";
import type {
  SteelLogger,
  SteelProviderConfig,
  SteelRetryEvent,
  SteelSessionResponse,
  WebSocketLike,
  WireClickPolicyDecision,
  WireClickRequest,
} from "./types.js";

export type {
  SteelLogger,
  SteelProviderConfig,
  SteelRetryEvent,
  WebSocketLike,
  WireClickPolicyDecision,
  WireClickRequest,
} from "./types.js";

// Some Steel deployments have a brief post-create propagation window where
// GET /sessions/{id} 404s for ~1-2s after the session is created. Retry on
// 404 with a short bounded budget so observe()'s first read doesn't crash.

// A wire.click on a submit/postback control or a navigating link tears down the
// JS execution context before the user code can `return`, so CDP rejects the
// user eval with one of these. When a wire action already succeeded this run,
// the teardown means the click navigated — a success, not a failure.
const EXEC_CONTEXT_NAVIGATED = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/iu;

function execNavigatedAfterWireAction(message: string, wireEvents: JsonObject[]): boolean {
  return EXEC_CONTEXT_NAVIGATED.test(message) &&
    wireEvents.some((event) => event.ok === true);
}

// Upper bound on how long to wait for a click-triggered navigation to finish
// loading before observing. Bounded so a hanging page cannot stall the run.
const NAVIGATION_SETTLE_TIMEOUT_MS = 8_000;

// A navigating click reloads the page; on a server-rendered postback (e.g.
// ASP.NET WebForms search) the result only exists after the new page loads. We
// wait for Page.loadEventFired — the new page's load, which is not fooled by
// the old page's already "complete" readyState. The caller only reaches here
// after a context-teardown error, so the old document is already gone: a direct
// document.readyState read here reflects the NEW document, never a stale one.
// That read covers the race where the new page finishes loading before
// Page.enable takes effect (so no load event is ever delivered). Resolves on
// the load event, an already-complete page, or a hard timeout (the click
// succeeded, so timing out is not a failure). The exec runs on a per-call
// connection that closes when exec returns, so the listener does not accumulate
// across execs.
async function waitForNavigatedPageToLoad(
  cdp: CdpConnection,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    cdp.on("Page.loadEventFired", (params) => {
      const sid = (params as { __sessionId?: string } | undefined)?.__sessionId;
      if (sid === undefined || sid === sessionId) finish();
    });
    // Page must be enabled to receive load events; if it is unsupported, fall
    // through to the timeout. After it is enabled, check whether the new page
    // already loaded (the load event would have been missed in that race).
    cdp.send("Page.enable", undefined, sessionId)
      .then(async () => {
        try {
          const readyState = await evaluateJson<string>(cdp, sessionId, "document.readyState");
          if (readyState === "complete") finish();
        } catch {
          // New context not ready yet; the load event will arrive.
        }
      })
      .catch(() => finish());
  });
}

export class SteelProvider implements BrowserProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly cdpCommandTimeoutMs: number;
  private readonly createSessionMaxRetries: number;
  private readonly getSessionRetryDelayMs: number;
  private readonly wireClickPolicy: (request: WireClickRequest) => WireClickPolicyDecision;
  private readonly onRetry: ((event: SteelRetryEvent) => void | Promise<void>) | undefined;
  private readonly logger: SteelLogger | undefined;

  constructor(config: SteelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.webSocketFactory = config.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.cdpCommandTimeoutMs = config.cdpCommandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    this.createSessionMaxRetries = config.createSessionMaxRetries ?? 0;
    this.getSessionRetryDelayMs = config.getSessionRetryDelayMs ?? DEFAULT_GET_SESSION_RETRY_DELAY_MS;
    this.wireClickPolicy = config.wireClickPolicy ?? defaultWireClickPolicy;
    this.onRetry = config.onRetry;
    this.logger = config.logger;
  }

  async createSession(input: CreateSessionInput = {}): Promise<BrowserSession> {
    const body = buildCreateSessionBody(input);
    const maxRetries = Math.max(0, Math.floor(this.createSessionMaxRetries));
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const steel = await steelFetch<SteelSessionResponse>(
          this.baseUrl,
          this.apiKey,
          "/sessions",
          { method: "POST", body: JSON.stringify(body) },
        );
        return toBrowserSession(steel, body.region);
      } catch (err) {
        lastError = err;
        const status = err instanceof SteelApiError ? err.status : 0;
        // Only retry on transient errors: 500+ or network failures (status 0)
        if (status !== 0 && status < 500) {
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = 500 * Math.pow(2, attempt);
          await this.onRetry?.({
            operation: "createSession",
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            status,
            message: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  async getSession(sessionId: SessionId): Promise<BrowserSession> {
    const steelId = extractSteelId(sessionId);
    let lastError: unknown;
    for (let attempt = 1; attempt <= GET_SESSION_MAX_ATTEMPTS; attempt++) {
      try {
        const steel = await steelFetch<SteelSessionResponse>(
          this.baseUrl,
          this.apiKey,
          `/sessions/${steelId}`,
        );
        return toBrowserSession(steel);
      } catch (err) {
        lastError = err;
        const status = err instanceof SteelApiError ? err.status : -1;
        if (status !== 404 || attempt === GET_SESSION_MAX_ATTEMPTS) {
          throw err;
        }
        if (this.getSessionRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.getSessionRetryDelayMs));
        }
      }
    }
    throw lastError;
  }

  async stopSession(sessionId: SessionId): Promise<void> {
    const steelId = extractSteelId(sessionId);
    await steelFetch<void>(
      this.baseUrl,
      this.apiKey,
      `/sessions/${steelId}/release`,
      { method: "POST" },
    );
  }

  private withAuth(session: BrowserSession): BrowserSession {
    if (!session.wsUrl) return session;
    const url = new URL(session.wsUrl);
    url.searchParams.set("apiKey", this.apiKey);
    return { ...session, wsUrl: url.toString() };
  }

  async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const targets = await listPageTargets(cdp);
      const target = pickTarget(targets, input.targetId);
      const sessionId = await attachToTarget(cdp, target.targetId);
      const script = input.includePageSketch === true ? OBSERVE_WITH_PAGE_SKETCH_SCRIPT : OBSERVE_SCRIPT;
      const snapshot = await evaluateJson<Record<string, unknown>>(cdp, sessionId, script);

      // Capture screenshot via CDP for multimodal LLM context
      let screenshotBase64: string | undefined;
      try {
        const screenshotResult = await cdp.send<{ data?: string }>(
          "Page.captureScreenshot",
          { format: "jpeg", quality: 50 },
          sessionId,
        );
        screenshotBase64 = screenshotResult.data;
      } catch {
        // Screenshot is best-effort; don't block observation if it fails
      }

      const observation: BrowserObservation = {
        sessionId: input.sessionId,
        targetId: target.targetId,
        url: asString(snapshot.url, target.url),
        title: asString(snapshot.title, target.title),
        tabs: targets.map((item) => ({
          id: item.targetId,
          title: item.title,
          url: item.url,
          active: item.targetId === target.targetId,
        })),
      };

      if (screenshotBase64) {
        observation.screenshotBase64 = screenshotBase64;
      }

      const focusedElement = asRecord(snapshot.focusedElement);
      if (focusedElement) {
        observation.focusedElement = focusedElement as NonNullable<BrowserObservation["focusedElement"]>;
      }
      const pageSummary = asRecord(snapshot.pageSummary);
      if (pageSummary) {
        observation.pageSummary = pageSummary as NonNullable<BrowserObservation["pageSummary"]>;
      }
      const pageSketch = asRecord(snapshot.pageSketch);
      if (pageSketch) {
        observation.pageSketch = pageSketch as unknown as NonNullable<BrowserObservation["pageSketch"]>;
      }

      return observation;
    });
  }

  async screenshot(input: BrowserScreenshotRequest): Promise<BrowserScreenshotResult> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const targets = await listPageTargets(cdp);
      const target = pickTarget(targets, input.targetId);
      const sessionId = await attachToTarget(cdp, target.targetId);
      const result = await cdp.send<{ data?: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      if (!result.data) {
        throw new Error("Page.captureScreenshot returned no data");
      }
      return {
        dataBase64: result.data,
        mimeType: "image/png",
        targetId: target.targetId,
      };
    });
  }

  async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const startedAt = Date.now();
      const targets = await listPageTargets(cdp);
      const selected = pickExecTargets(targets, input.target);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const wireEvents: JsonObject[] = [];
      let ok = true;
      let returnValue: unknown;

      for (const target of selected) {
        let sessionId: string | undefined;
        try {
          validateBrowserCode(input.code);
          sessionId = await attachToTarget(cdp, target.targetId);
          await installWireClickBinding(cdp, sessionId, wireEvents, this.wireClickPolicy);
          const value = await evaluateJson<unknown>(cdp, sessionId, wrapUserCode(input.code), input.timeoutMs);
          returnValue = value;
          if (value !== undefined) {
            stdout.push(typeof value === "string" ? value : JSON.stringify(value));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (returnValue === undefined && execNavigatedAfterWireAction(message, wireEvents)) {
            // The click landed and navigated the page. Wait for the new page to
            // finish loading before reporting, so the next observation reads the
            // loaded result page rather than the mid-navigation one; then report
            // the navigation instead of the teardown.
            if (sessionId !== undefined) {
              await waitForNavigatedPageToLoad(cdp, sessionId, NAVIGATION_SETTLE_TIMEOUT_MS);
            }
            returnValue = { navigated: true };
          } else {
            ok = false;
            stderr.push(message);
          }
        }
      }

      const result: BrowserExecResult = {
        ok,
        durationMs: Date.now() - startedAt,
      };
      if (stdout.length > 0) {
        result.stdout = stdout.join("\n");
      }
      if (stderr.length > 0) {
        result.stderr = stderr.join("\n");
      }
      if (returnValue !== undefined) {
        result.returnValue = returnValue as NonNullable<BrowserExecResult["returnValue"]>;
      }
      if (wireEvents.length > 0) {
        result.wireEvents = wireEvents;
      }
      return result;
    });
  }

  async raw(input: BrowserRawRequest): Promise<unknown> {
    const session = this.withAuth(await this.getSession(input.sessionId));
    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const needsTargetSession = cdpMethodNeedsTargetSession(input.method);
      if (needsTargetSession) {
        const targets = await listPageTargets(cdp);
        const target = pickTarget(targets);
        const targetSessionId = await attachToTarget(cdp, target.targetId);
        const raw = capRawRuntimeEvaluate(input.method, input.params);
        return cdp.send(input.method, raw.params, targetSessionId, raw.timeoutMs);
      }
      const raw = capRawRuntimeEvaluate(input.method, input.params);
      return cdp.send(input.method, raw.params, undefined, raw.timeoutMs);
    });
  }

  /**
   * Send multiple CDP commands over a single connection.
   * Reuses one WebSocket and target session attachment for all commands.
   * Returns the result of the last command, or throws on the first failure.
   */
  async rawBatch(
    sessionId: SessionId,
    commands: Array<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<unknown> {
    const session = this.withAuth(await this.getSession(sessionId));
    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const needsTarget = commands.some((c) => cdpMethodNeedsTargetSession(c.method));
      let targetSessionId: string | undefined;
      if (needsTarget) {
        const targets = await listPageTargets(cdp);
        const target = pickTarget(targets);
        targetSessionId = await attachToTarget(cdp, target.targetId);
      }

      let lastResult: unknown;
      for (const cmd of commands) {
        const sid = cdpMethodNeedsTargetSession(cmd.method) ? targetSessionId : undefined;
        const raw = capRawRuntimeEvaluate(cmd.method, cmd.params);
        lastResult = await cdp.send(cmd.method, raw.params, sid, raw.timeoutMs);
      }
      return lastResult;
    });
  }
}

const LINK_SAMPLE_HELPERS = `
  const LINK_SAMPLE_LIMITS = {
    maxItems: ${BROWSER_LINK_SAMPLE_LIMITS.maxItems},
    maxLabelChars: ${BROWSER_LINK_SAMPLE_LIMITS.maxLabelChars},
    maxHrefChars: ${BROWSER_LINK_SAMPLE_LIMITS.maxHrefChars},
    maxTotalChars: ${BROWSER_LINK_SAMPLE_LIMITS.maxTotalChars},
  };

  function normalizeLinkSampleText(value) {
    return String(value || "").replace(/\\s+/g, " ").trim();
  }

  function isVisibleLinkSample(anchor) {
    if (!(anchor instanceof Element)) return false;
    if (anchor.closest("[hidden],[aria-hidden=\\"true\\"]")) return false;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(anchor);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && Number(style.opacity || 1) !== 0;
  }

  function collectLinkSamples() {
    const priorityAnchors = Array.from(document.querySelectorAll("nav a[href],aside a[href],[role=\\"navigation\\"] a[href]"));
    const anchors = priorityAnchors.concat(Array.from(document.querySelectorAll("a[href]")));
    const samples = [];
    const seenHrefs = new Set();
    let totalChars = 0;

    for (const anchor of anchors) {
      if (samples.length >= LINK_SAMPLE_LIMITS.maxItems) break;
      if (!isVisibleLinkSample(anchor)) continue;

      let href;
      try {
        const rawHref = anchor.getAttribute("href");
        if (!rawHref) continue;
        const url = new URL(rawHref, document.baseURI);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        href = url.href;
      } catch {
        continue;
      }
      if (href.length > LINK_SAMPLE_LIMITS.maxHrefChars || seenHrefs.has(href)) continue;

      const visibleText = normalizeLinkSampleText(anchor.innerText || anchor.textContent);
      const fallback = normalizeLinkSampleText(anchor.getAttribute("aria-label") || anchor.getAttribute("title"));
      const label = (visibleText || fallback).slice(0, LINK_SAMPLE_LIMITS.maxLabelChars);
      if (!label) continue;

      const itemChars = label.length + href.length;
      if (totalChars + itemChars > LINK_SAMPLE_LIMITS.maxTotalChars) continue;
      seenHrefs.add(href);
      samples.push({ label, href });
      totalChars += itemChars;
    }

    return samples;
  }
`;

const OBSERVE_SCRIPT = `(() => {
${LINK_SAMPLE_HELPERS}
  // Orientation-only: where am I, what's on the page, what can I interact with.
  // Content extraction is the agent's job via exec — not the observer's.
  const headings = [];
  for (const h of document.querySelectorAll("h1,h2,h3")) {
    const t = (h.textContent ?? "").trim();
    if (t && headings.length < 5) headings.push(t.slice(0, 120));
  }
  const active = document.activeElement;
  return {
    url: window.location.href,
    title: document.title,
    focusedElement: active ? {
      tag: active.tagName?.toLowerCase?.(),
      role: active.getAttribute?.("role") ?? undefined,
      label: active.getAttribute?.("aria-label") ?? undefined,
      selectorHint: active.id ? "#" + active.id : undefined,
    } : undefined,
    pageSummary: {
      headings,
      forms: document.forms.length,
      buttons: document.querySelectorAll("button, input[type=button], input[type=submit]").length,
      dialogs: document.querySelectorAll("dialog, [role=\\"dialog\\"]").length,
      tables: document.querySelectorAll("table").length,
      links: document.querySelectorAll("a[href]").length,
      inputs: document.querySelectorAll("input,textarea,select").length,
      linkSamples: collectLinkSamples(),
    },
  };
})()`;

const OBSERVE_WITH_PAGE_SKETCH_SCRIPT = `(() => {
${LINK_SAMPLE_HELPERS}
  const PAGE_SKETCH_LIMITS = {
    maxSections: 12,
    maxControlsPerSection: 12,
    maxTextPreviewChars: 280,
  };
  const MAX_LABEL_CHARS = 120;
  const MAX_SELECTOR_ALTERNATES = 3;

  function normalizeText(value) {
    return String(value || "").replace(/\\s+/g, " ").trim();
  }

  function cap(value, max) {
    const text = normalizeText(value);
    return text.length > max ? text.slice(0, max - 3).trimEnd() + "..." : text;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function quoteAttr(value) {
    return JSON.stringify(String(value)).slice(1, -1);
  }

  function isLikelyGeneratedId(id) {
    if (!id || id.length > 48) return true;
    if (/^[a-f0-9-]{16,}$/iu.test(id)) return true;
    if ((id.match(/\\d/g) || []).length > Math.max(3, id.length / 2)) return true;
    return false;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
  }

  function stableAttrSelector(el, tag) {
    const attrs = ["data-testid", "data-test", "data-qa", "data-cy"];
    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (value) return tag + "[" + attr + "=\\"" + quoteAttr(value) + "\\"]";
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length <= 80) return tag + "[aria-label=\\"" + quoteAttr(aria) + "\\"]";
    if (/^(input|textarea|select|button|form)$/u.test(tag)) {
      const name = el.getAttribute("name");
      if (name) return tag + "[name=\\"" + quoteAttr(name) + "\\"]";
      const type = el.getAttribute("type");
      if (type && tag !== "input") return tag + "[type=\\"" + quoteAttr(type) + "\\"]";
    }
    return "";
  }

  function firstStableClass(el) {
    for (const cls of Array.from(el.classList || [])) {
      if (cls.length > 0 && cls.length <= 40 && !/^[a-f0-9_-]{12,}$/iu.test(cls)) return cls;
    }
    return "";
  }

  function selectorFor(el, depth = 0) {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id");
    if (id && !isLikelyGeneratedId(id)) return "#" + cssEscape(id);
    const attrSelector = stableAttrSelector(el, tag);
    if (attrSelector) return attrSelector;
    const cls = firstStableClass(el);
    if (cls) return tag + "." + cssEscape(cls);
    if (depth < 1 && el.parentElement && el.parentElement !== document.body) {
      const siblings = Array.from(el.parentElement.children).filter((child) => child.tagName === el.tagName);
      if (siblings.length > 1) {
        return selectorFor(el.parentElement, depth + 1) + " > " + tag + ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
      }
    }
    return tag;
  }

  function elementText(el) {
    return normalizeText(el.innerText || el.textContent || "");
  }

  function controlLabel(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return cap(aria, MAX_LABEL_CHARS);
    const title = el.getAttribute("title");
    if (title) return cap(title, MAX_LABEL_CHARS);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return cap(placeholder, MAX_LABEL_CHARS);
    if (el.labels && el.labels.length > 0) {
      const label = Array.from(el.labels).map((labelEl) => elementText(labelEl)).filter(Boolean).join(" ");
      if (label) return cap(label, MAX_LABEL_CHARS);
    }
    const alt = el.getAttribute("alt");
    if (alt) return cap(alt, MAX_LABEL_CHARS);
    const value = el.getAttribute("value");
    if (value && /^(button|submit|reset)$/iu.test(el.getAttribute("type") || "")) return cap(value, MAX_LABEL_CHARS);
    return cap(elementText(el), MAX_LABEL_CHARS);
  }

  function selectorAlternates(el, primary) {
    const tag = el.tagName.toLowerCase();
    const alternates = [];
    const role = el.getAttribute("role");
    if (role) alternates.push(tag + "[role=\\"" + quoteAttr(role) + "\\"]");
    const href = el.getAttribute("href");
    if (href && href.length <= 120) alternates.push("a[href=\\"" + quoteAttr(href) + "\\"]");
    return alternates.filter((item, index, all) => item !== primary && all.indexOf(item) === index).slice(0, MAX_SELECTOR_ALTERNATES);
  }

  function controlFrom(el) {
    if (!isVisible(el)) return null;
    const tag = el.tagName.toLowerCase();
    const selectorHint = selectorFor(el);
    const label = controlLabel(el);
    const control = { label, tag, selectorHint };
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    const href = el.getAttribute("href");
    const alternates = selectorAlternates(el, selectorHint);
    if (role) control.role = role;
    if (type) control.type = type;
    if (href) control.href = href;
    if (alternates.length > 0) control.selectorAlternates = alternates;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") control.disabled = true;
    if (el.required === true || el.getAttribute("aria-required") === "true") control.required = true;
    return control;
  }

  function countsFor(el) {
    return {
      links: el.querySelectorAll("a[href]").length,
      buttons: el.querySelectorAll("button,input[type=button],input[type=submit],[role=\\"button\\"]").length,
      inputs: el.querySelectorAll("input,textarea,select,[contenteditable=\\"true\\"],[role=\\"combobox\\"]").length,
      tables: el.querySelectorAll("table").length + (el.tagName.toLowerCase() === "table" ? 1 : 0),
      lists: el.querySelectorAll("ul,ol,[role=\\"list\\"],[role=\\"grid\\"]").length,
    };
  }

  function kindFor(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    if (tag === "dialog" || role === "dialog") return "dialog";
    if (tag === "nav" || role === "navigation") return "nav";
    if (tag === "header") return "header";
    if (tag === "main" || role === "main") return "main";
    if (tag === "form") return "form";
    if (tag === "table" || role === "table" || role === "grid") return "table";
    if (tag === "ul" || tag === "ol" || role === "list") return "list";
    if (tag === "footer") return "footer";
    return "content";
  }

  function headingFor(el) {
    if (/^h[1-6]$/iu.test(el.tagName)) return cap(elementText(el), 120);
    const heading = el.querySelector("h1,h2,h3,[role=\\"heading\\"]");
    return heading ? cap(elementText(heading), 120) : "";
  }

  function labelForSection(el, heading) {
    const aria = el.getAttribute("aria-label");
    if (aria) return cap(aria, 120);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return cap(elementText(labelEl), 120);
    }
    return heading || "";
  }

  function makeSection(el, index) {
    const kind = kindFor(el);
    const heading = headingFor(el);
    const label = labelForSection(el, heading);
    const rect = el.getBoundingClientRect();
    const controls = [];
    const seenControls = new Set();
    const controlEls = Array.from(el.querySelectorAll("a[href],button,input,textarea,select,[role=\\"button\\"],[role=\\"link\\"],[role=\\"combobox\\"],[role=\\"tab\\"],[contenteditable=\\"true\\"]"));
    for (const controlEl of controlEls) {
      if (controls.length >= PAGE_SKETCH_LIMITS.maxControlsPerSection) break;
      const control = controlFrom(controlEl);
      if (!control) continue;
      const key = control.selectorHint + "|" + control.label;
      if (seenControls.has(key)) continue;
      seenControls.add(key);
      controls.push(control);
    }
    const section = {
      id: "section-" + (index + 1),
      kind,
      selectorHint: selectorFor(el),
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      counts: countsFor(el),
      controls,
    };
    if (label) section.label = label;
    if (heading) section.heading = heading;
    const preview = cap(elementText(el), PAGE_SKETCH_LIMITS.maxTextPreviewChars);
    if (preview) section.textPreview = preview;
    return section;
  }

  const headings = [];
  for (const h of document.querySelectorAll("h1,h2,h3")) {
    const t = normalizeText(h.textContent);
    if (t && headings.length < 5) headings.push(t.slice(0, 120));
  }
  const active = document.activeElement;
  const pageSummary = {
    headings,
    forms: document.forms.length,
    buttons: document.querySelectorAll("button, input[type=button], input[type=submit]").length,
    dialogs: document.querySelectorAll("dialog, [role=\\"dialog\\"]").length,
    tables: document.querySelectorAll("table").length,
    links: document.querySelectorAll("a[href]").length,
    inputs: document.querySelectorAll("input,textarea,select").length,
    linkSamples: collectLinkSamples(),
  };

  const priority = {
    dialog: 0,
    header: 1,
    nav: 1,
    form: 2,
    table: 2,
    main: 3,
    list: 4,
    content: 6,
    footer: 9,
  };
  const sectionSelector = "dialog,[role=\\"dialog\\"],header,nav,main,[role=\\"main\\"],form,table,[role=\\"table\\"],[role=\\"grid\\"],ul,ol,[role=\\"list\\"],section,article,footer";
  const candidates = Array.from(document.querySelectorAll(sectionSelector))
    .filter(isVisible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const kind = kindFor(el);
      const inViewport = rect.bottom >= 0 && rect.top <= window.innerHeight;
      return { el, kind, rect, inViewport };
    })
    .sort((a, b) => {
      const pa = priority[a.kind] ?? 6;
      const pb = priority[b.kind] ?? 6;
      if (pa !== pb) return pa - pb;
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      return a.rect.top - b.rect.top;
    });

  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.length >= PAGE_SKETCH_LIMITS.maxSections) break;
    if (chosen.some((existing) => existing.el.contains(candidate.el) && existing.kind === candidate.kind)) continue;
    chosen.push(candidate);
  }

  return {
    url: window.location.href,
    title: document.title,
    focusedElement: active ? {
      tag: active.tagName?.toLowerCase?.(),
      role: active.getAttribute?.("role") ?? undefined,
      label: active.getAttribute?.("aria-label") ?? undefined,
      selectorHint: active.id ? "#" + active.id : undefined,
    } : undefined,
    pageSummary,
    pageSketch: {
      version: 1,
      generatedAt: new Date().toISOString(),
      sections: chosen.map((item, index) => makeSection(item.el, index)),
      truncated: candidates.length > chosen.length,
      limits: PAGE_SKETCH_LIMITS,
    },
  };
})()`;

function wrapUserCode(code: string): string {
  return `(async () => { ${code} })()`;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function createSteelProvider(
  config?: Partial<SteelProviderConfig>,
): SteelProvider {
  const apiKey = config?.apiKey ?? process.env.STEEL_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("STEEL_API_KEY is required. Set the environment variable or pass apiKey in config.");
  }

  const providerConfig: SteelProviderConfig = { apiKey };
  const baseUrl = config?.baseUrl ?? process.env.STEEL_BASE_URL;
  if (baseUrl) {
    providerConfig.baseUrl = baseUrl;
  }
  if (config?.webSocketFactory) {
    providerConfig.webSocketFactory = config.webSocketFactory;
  }
  if (config?.cdpCommandTimeoutMs) {
    providerConfig.cdpCommandTimeoutMs = config.cdpCommandTimeoutMs;
  }
  if (config?.onRetry) {
    providerConfig.onRetry = config.onRetry;
  }
  if (config?.createSessionMaxRetries !== undefined) {
    providerConfig.createSessionMaxRetries = config.createSessionMaxRetries;
  }
  if (config?.getSessionRetryDelayMs !== undefined) {
    providerConfig.getSessionRetryDelayMs = config.getSessionRetryDelayMs;
  }
  if (config?.wireClickPolicy) {
    providerConfig.wireClickPolicy = config.wireClickPolicy;
  }
  if (config?.logger) {
    providerConfig.logger = config.logger;
  }

  return new SteelProvider(providerConfig);
}
