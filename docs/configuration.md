# Configuration

Wire uses a layered configuration system. Settings resolve in priority order, with CLI flags and environment variables overriding file-based config.

## LLM provider selection

Provider and model values are first resolved from CLI, environment, and config files. The selected provider is then validated against the selected model.

1. `--provider openai` / `--provider anthropic` CLI flag
2. `WIRE_PROVIDER` environment variable
3. `wire.json` → `llm.provider`
4. `~/.wire/config.json` → `llm.provider`
5. Model name inference when no provider was set (e.g., `gpt-*` → OpenAI, `claude-*` → Anthropic)
6. Available API key when no provider or inferable model was set (OpenAI wins when both keys are present)

If both OpenAI and Anthropic keys are present and no provider or inferable model is configured, Wire defaults to OpenAI. Configure `--provider`, `WIRE_PROVIDER`, or `llm.provider` when you want Anthropic.

### Provider validation

- Model names must match their provider (`gpt-*` with OpenAI, `claude-*` with Anthropic)
- Mismatched pairs are rejected with a descriptive error

### Default models

| Provider | Default model |
|----------|--------------|
| OpenAI | `gpt-5.4-mini` |
| Anthropic | `claude-sonnet-4-6` |

Override with `--model` or `WIRE_MODEL`.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `STEEL_API_KEY` | Steel browser API key (required) | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `WIRE_PROVIDER` | Override LLM provider | — |
| `WIRE_MODEL` | Override LLM model | — |
| `WIRE_LLM_TIMEOUT_MS` | Per-request LLM transport timeout | `60000` |
| `WIRE_LLM_MAX_RETRIES` | Bounded retry count for transient LLM network failures | `2` |
| `WIRE_HOME` | User-level Wire home | `~/.wire` |
| `WIRE_ROOT` | Storage root | `$WIRE_HOME/state` |
| `WIRE_SKILLS` | Skills directory | `$WIRE_HOME/skills` |
| `WIRE_TRACE_LLM_MESSAGES` | Set to `1` to trace LLM prompts/responses | — |

## Project config: wire.json

Place a `wire.json` file in the project root for project-level defaults:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-5.4-mini"
  },
  "browser": {
    "session": {
      "useProxy": true,
      "stealth": true,
      "region": "us-east-1"
    }
  }
}
```

### Config fields

| Field | Type | Description |
|-------|------|-------------|
| `llm.provider` | `"openai"`, `"anthropic"` | Default LLM provider |
| `llm.model` | string | Default model |
| `browser.session` | `SessionConfig` | Default browser session settings |

## User config: ~/.wire/config.json

User-level defaults that apply across all projects:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6"
  }
}
```

## Config loading

`src/cli/config.ts` reads both config files and merges project settings over user defaults:

1. User `~/.wire/config.json`
2. Project `wire.json` (from current working directory)

Project config takes precedence over user config for overlapping fields.

With `--strict`, missing or invalid config files cause errors. Without it, missing files are silently ignored.

## Browser session config

Session options can be set via CLI flags or config files:

| Setting | CLI flag | Config path | Description |
|---------|----------|------------|-------------|
| Proxy | `--use-proxy` | `browser.session.useProxy` | Enable provider proxy |
| Captcha | `--solve-captcha` | `browser.session.solveCaptcha` | Enable captcha solving |
| Stealth | `--stealth` | `browser.session.stealth` | Stealth mode |
| Region | `--region` | `browser.session.region` | Browser region |
| User agent | `--user-agent` | `browser.session.userAgent` | Custom user agent |
| Viewport | — | `browser.session.viewport` | `{ width, height }` |
| Locale | — | `browser.session.locale` | Browser locale |
| Timezone | — | `browser.session.timezone` | Browser timezone |

## Step budget defaults

| Mode | Default max steps |
|------|------------------|
| `task` | 30 |
| `investigate` | 20 |
| `experiment` | 25 |

Override with `--max-steps`.

## Runtime configuration

When embedding Wire programmatically, construct a `RuntimeConfig`:

```ts
import { createPolicyEngine } from "./policy/engine.js";
import { createSteelProvider } from "./providers/browser/steel.js";
import { createOpenAIProvider } from "./providers/llm/openai.js";

const config: RuntimeConfig = {
  provider: createSteelProvider(),
  policyEngine: createPolicyEngine(),
  llmProvider: createOpenAIProvider({ model: "gpt-5.4-mini" }),
  maxSteps: 20,
  skillDir: "./skills",
  sessionInput: {
    timeoutMinutes: 30,
    sessionConfig: { useProxy: true },
  },
};
```

### RuntimeConfig fields

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `BrowserProvider` | Browser provider (required) |
| `policyEngine` | `PolicyEngine` | Policy rules engine (required) |
| `llmProvider` | `LLMProvider` | LLM for agent reasoning |
| `maxSteps` | number | Step budget |
| `skillDir` | string | Skills directory |
| `sessionInput` | `CreateSessionInput` | Browser session creation options |
| `onSessionCreated` | callback | Called when a session is created |
| `onSessionReconfigured` | callback | Called when session is reconfigured |
| `traceSink` | `TraceSink` | Event listener for trace events |
| `traceLlmMessages` | boolean | Whether to store LLM messages as blobs |
| `saveTraceBlob` | function | Custom blob storage handler |
| `actionHandlers` | `ActionHandler[]` | Provider-specific action handlers |
| `keepSessionOpen` | boolean | Keep session alive after run |
| `cancelSignal` | `AbortSignal` | Signal to cancel the run |
| `pauseToken` | `PauseToken` | Pause/resume control |
| `userMessageInbox` | `UserMessageInbox` | Inject user messages mid-run |
| `existingSession` | `BrowserSession` | Reuse an existing session |
| `releaseExistingSessionOnExit` | boolean | Stop the session on run end |
