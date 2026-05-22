# Browser Bridge

The browser bridge is the interface between the agent runtime and a real Chrome browser. It exposes three first-class operations through the `BrowserProvider` contract.

## BrowserProvider interface

Defined in `src/browser/bridge.ts`:

```ts
interface BrowserProvider {
  createSession(input: CreateSessionInput): Promise<BrowserSession>;
  getSession(sessionId: SessionId): Promise<BrowserSession>;
  stopSession(sessionId: SessionId): Promise<void>;
  observe(input: BrowserObserveInput): Promise<BrowserObservation>;
  exec(input: BrowserExecRequest): Promise<BrowserExecResult>;
  raw?(input: BrowserRawRequest): Promise<unknown>;
}
```

The Steel provider (`src/providers/browser/steel.ts`) implements this interface using the Steel API.

## The three operations

### 1. observe()

Returns a compact orientation snapshot of the current page.

```ts
interface BrowserObserveInput {
  sessionId: SessionId;
  targetId?: string;
}
```

Returns a `BrowserObservation`:

```ts
interface BrowserObservation {
  sessionId: SessionId;
  targetId?: string;
  url: string;
  title: string;
  tabs: BrowserTabSummary[];
  screenshotArtifactId?: ArtifactId;
  screenshotBase64?: string;
  htmlArtifactId?: ArtifactId;
  markdownArtifactId?: ArtifactId;
  focusedElement?: BrowserFocusContext;
  pageSummary?: BrowserPageSummary;
}
```

Observation is **orientation-only** — URL, title, headings, element counts. It answers "where am I?" and "did my action work?". Content extraction is the agent's job via `exec()`.

The page summary includes counts of: headings, forms, buttons, dialogs, tables, links, and inputs.

### 2. exec()

Executes JavaScript against the current browser session.

```ts
interface BrowserExecRequest {
  sessionId: SessionId;
  code: string;
  timeoutMs?: number;
  target?: BrowserExecTarget;
  attachments?: string[];
}
```

Returns a `BrowserExecResult`:

```ts
interface BrowserExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  returnValue?: JsonValue;
  wireEvents?: JsonObject[];
  artifactIds?: ArtifactId[];
  durationMs: number;
}
```

The agent writes whatever JavaScript the task requires — navigation, extraction, interaction, verification, form filling, API calls, DOM manipulation. This is the primary action mechanism.

Exec targets:
- `"active-tab"` — run in the current tab (default)
- `"all-tabs"` — run in all open tabs
- `{ tabId: string }` — run in a specific tab

#### `wire.click()`

Every Steel-backed `exec()` context includes a small page-side `wire.click(target)` binding for user-facing clicks that should reach the page as real browser input.

```js
const btn = [...document.querySelectorAll("button,a,[role=button]")]
  .find((el) => /continue|accept/i.test(el.textContent || ""));
await wire.click(btn);
```

The agent still uses ordinary JavaScript to find the target. `wire.click()` only changes how the click is delivered: the page shim snapshots the element's viewport coordinates and target metadata, then the host dispatches a narrow CDP mouse move/press/release sequence. It does not add auto-waiting, retries, a selector DSL, typing, navigation, or a new sandbox.

The binding records structured `wireEvents` on the exec result with fields such as action, coordinates, button, tag, text, aria label, and selector hint. Those events are used for trace display and audit evidence.

Policy boundary:
- The exec source is still checked before execution.
- Runtime click metadata is checked again before CDP dispatch.
- Destructive targets such as "Delete account" are blocked before any mouse event is sent.
- Sensitive targets such as payment, checkout, account, billing, permission, or outbound-message actions are rejected as requiring approval before dispatch.

Frame boundary:
- Main-frame elements and same-origin iframe elements are supported.
- Cross-origin iframe elements are not directly passable from the parent page. Use a target-specific execution context or raw CDP coordinates when that is truly needed.

### 3. raw()

Sends Chrome DevTools Protocol (CDP) commands directly.

```ts
interface BrowserRawRequest {
  sessionId: SessionId;
  method: string;
  params?: JsonObject;
}
```

This is the escape hatch for when `exec()` is insufficient. It is:
- Visible in trace events
- Policy-gated (requires approval unless the method is a safe input method)
- Not the default thought path

## Session lifecycle

Sessions are managed by `src/browser/session.ts`:

1. **Create** — `createBrowserSession(provider, input)` creates a new Steel session
2. **Use** — the session ID is passed to observe/exec/raw
3. **Stop** — `stopBrowserSession(provider, sessionId)` releases the session

By default, sessions are stopped when the run completes. Set `keepSessionOpen: true` in the runtime config to keep them alive.

## Helpers

`src/browser/helpers.ts` provides thin helper code that can be injected into exec calls. Helpers are:
- Ordinary TypeScript functions
- Callable from `exec()`
- Editable by the agent
- Changes captured as artifacts and diffs

Example helpers: `clickVisibleText()`, `fillByLabel()`, `uploadFile()`, `extractTable()`.

## Session configuration

When creating a session, you can pass:

```ts
interface SessionConfig {
  useProxy?: boolean | ProxyConfig;
  solveCaptcha?: boolean;
  stealth?: boolean;
  userAgent?: string;
  region?: string;
  locale?: string;
  timezone?: string;
  viewport?: ViewportConfig;
  providerOptions?: JsonObject;
}
```

These are forwarded to the Steel provider. The `reconfigure` provider action can change these mid-run (e.g., enabling proxy for anti-bot recovery).

## Steel provider

`src/providers/browser/steel.ts` implements the `BrowserProvider` interface using the Steel cloud browser API.

Key features:
- Session creation with profile, region, proxy, and captcha support
- Observation via Steel's page snapshot endpoint
- Code execution via Steel's evaluate endpoint
- Raw CDP access via Steel's CDP endpoint
- A `reconfigure` action handler for mid-run session changes

Configuration is via the `STEEL_API_KEY` environment variable.
