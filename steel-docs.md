# Auth Context Starter
URL: /cookbook/auth-context-starter

---
title: Auth Context Starter
sidebarTitle: Auth Context Starter
isLink: true
llm: false
---


# Credentials API Starter
URL: /cookbook/credentials-starter

---
title: Credentials API Starter
sidebarTitle: Credentials API Starter
isLink: true
llm: false
---


# Extensions API Starter
URL: /cookbook/extensions-starter

---
title: Extensions API Starter
sidebarTitle: Extensions API Starter
isLink: true
llm: false
---


# Files API Starter
URL: /cookbook/files-starter

---
title: Files API Starter
sidebarTitle: Files API Starter
isLink: true
llm: false
---


# Playwright
URL: /cookbook/playwright

---
title: Playwright
sidebarTitle: Playwright
isLink: true
llm: false
---


# Puppeteer
URL: /cookbook/puppeteer

---
title: Puppeteer
sidebarTitle: Puppeteer
isLink: true
llm: false
---


# Selenium
URL: /cookbook/selenium

---
title: Selenium
sidebarTitle: Selenium
isLink: true
llm: false
---


# Stagehand (Python)
URL: /cookbook/stagehand-py

---
title: Stagehand (Python)
sidebarTitle: Stagehand (Python)
isLink: true
llm: false
---


# Stagehand (Typescript)
URL: /cookbook/stagehand-ts

---
title: Stagehand (Typescript)
sidebarTitle: Stagehand (Typescript)
isLink: true
llm: false
---


# Authentication
URL: /overview/authentication

---
title: Authentication
sidebarTitle: Authentication
description: Authenticate requests to the Steel API and Steel SDKs using an API key.
llm: true
---

Every request to Steel is authenticated with an API key tied to your organization. This page covers how to get a key, how to use it with the REST API, SDKs, and WebSocket connections, and how to manage and rotate keys over time.

### Overview

Steel uses API key authentication. Once you've created a key in the dashboard, you pass it to Steel one of three ways depending on the interface you're using:

- **REST API**: as the `steel-api-key` HTTP header
- **SDKs (Node.js / Python)**: as a client option, or via the `STEEL_API_KEY` environment variable
- **Browser connections (CDP over WebSocket)**: as the `apiKey` query parameter on `wss://connect.steel.dev`

A single key grants access to your entire organization's Steel resources: sessions, files, credentials, profiles, and everything else. Treat it like a password.

### Getting Your API Key

1. Sign in at [app.steel.dev](https://app.steel.dev).
2. Open **Settings → API Keys** ([direct link](https://app.steel.dev/settings/api-keys)).
3. Click **Create API Key**, give it a descriptive name (e.g. `production`, `local-dev`, `ci`), and copy the value.

:::callout
type: warn

### Save your key somewhere safe

The full key is only shown once at the moment of creation. If you lose it, you'll need to delete the key and create a new one.
:::

### Setting Up Environment Variables

Both SDKs and most example code in these docs assume your key is available as the `STEEL_API_KEY` environment variable. The easiest setup is a `.env` file in your project root:

```bash .env -wcn
STEEL_API_KEY=ste-your-api-key-here
```

Make sure `.env` is listed in your `.gitignore` so the key never lands in version control.

### Using the API Key

#### SDKs

If `STEEL_API_KEY` is set in your environment, the official SDKs will pick it up automatically. You don't need to pass anything explicitly.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

// Reads STEEL_API_KEY from the environment
const client = new Steel();

const session = await client.sessions.create();
```

```python !! Python -wcn
from steel import Steel

# Reads STEEL_API_KEY from the environment
client = Steel()

session = client.sessions.create()
```

</CodeTabs>

You can also pass the key explicitly, which is useful when you manage multiple keys or fetch the value from a secrets manager at runtime:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from "steel-sdk";

const client = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});
```

```python !! Python -wcn
import os
from steel import Steel

client = Steel(
    steel_api_key=os.environ["STEEL_API_KEY"],
)
```

</CodeTabs>

#### REST API

When calling the REST API directly, send your key in the `steel-api-key` header.

```bash cURL -wcn
curl https://api.steel.dev/v1/sessions \
  -H "steel-api-key: $STEEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The same header works for every authenticated endpoint: sessions, files, credentials, profiles, extensions, and so on. See the [API Reference](/api-reference) for the full list.

#### Browser Connections (CDP over WebSocket)

When connecting an automation framework (Playwright, Puppeteer, Selenium) to a live Steel session over the Chrome DevTools Protocol, pass your key as the `apiKey` query parameter on the `wss://connect.steel.dev` endpoint:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(
  `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`,
);
```

```python !! Python -wcn
import os
from playwright.sync_api import sync_playwright

playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp(
    f"wss://connect.steel.dev?apiKey={os.environ['STEEL_API_KEY']}&sessionId={session.id}"
)
```

</CodeTabs>

The `sessionId` parameter is optional: if omitted, Steel will start a new session with default settings and connect you to it. See the framework-specific guides for full examples: [Puppeteer](/cookbook/puppeteer), [Playwright](/cookbook/playwright), [Playwright (Python)](/cookbook/playwright-python), [Selenium](/cookbook/selenium).

#### Steel CLI

The [Steel CLI](/overview/steel-cli) authenticates with the same keys. The easiest way is:

```bash Terminal -wcn
steel login
```

This walks you through signing in and stores a key locally. Alternatively, set `STEEL_API_KEY` in your environment and the CLI will use it directly: useful for CI and non-interactive environments.

### Managing Your API Keys

All key management happens in the [API Keys dashboard](https://app.steel.dev/settings/api-keys). From there you can:

- **Create** a new key: pick a clear name so you can later identify where it's being used.
- **View** the list of existing keys, when they were created, and when they were last used.
- **Delete** a key: this immediately revokes it. Any service still using that key will start receiving `401 Unauthorized` responses.

Steel does not currently expose key management through the public API: keys are only created and deleted through the dashboard.

#### Rotating Keys

To rotate a key without downtime:

1. Create a new API key in the dashboard.
2. Roll the new key out to all the places that use it (environment variables, secret managers, CI, etc.).
3. Verify traffic is flowing under the new key (the "Last used" timestamp in the dashboard will update).
4. Delete the old key.

We recommend using separate keys per environment (e.g. `production`, `staging`, `local-dev`) so you can rotate them independently and narrow the blast radius of a leak.

### Security Best Practices

- **Never commit keys to source control.** Use `.env` files (and `.gitignore` them), your platform's secret manager, or CI secrets.
- **Never ship keys in client-side code.** Steel keys are meant for trusted server-side environments. Exposing one in a browser bundle, mobile app, or public repo effectively makes it public.
- **Scope keys per environment.** One key per environment (prod, staging, dev) makes incidents easier to contain.
- **Rotate on suspicion.** If a key might have been exposed (in logs, a screenshare, a repo, a CI job), delete it and create a new one immediately.
- **Use the `name` field.** Naming your keys when you create them makes it much easier to audit and revoke the right one later.

### Troubleshooting

If Steel rejects your request, you'll get an HTTP `401 Unauthorized` with a short message explaining why:

- **`Invalid Steel API Key`**: the key you sent doesn't match any active key on your account. Double-check it for typos, trailing whitespace, or the wrong environment variable. If you recently deleted the key, it will no longer work.
- **`Missing API key`**: no `steel-api-key` header was sent. Make sure your SDK client was initialized with a key, or that the header is present on your raw HTTP request.
- **`Account suspended`** (`403 Forbidden`): your organization has been blocked. Reach out to [team@steel.dev](mailto:team@steel.dev?subject=Account%20Suspension) to resolve this.

A quick way to sanity-check a key is to hit the sessions endpoint:

```bash Terminal -wcn
curl -i https://api.steel.dev/v1/sessions \
  -H "steel-api-key: $STEEL_API_KEY"
```

A `200 OK` means you're authenticated. A `401` means the key is wrong or missing.

:::callout
type: help

### Stuck on auth?

Ping us in the **#help** channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section, or email [team@steel.dev](mailto:team@steel.dev?subject=Authentication%20Help).
:::


# Intro to Steel
URL: /overview/intro-to-steel

---
title: Intro to Steel
description: Humans use Chrome, Agents use Steel.
sidebarTitle: Intro to Steel
llm: true
---
import Image from 'next/image'

<Image src="/images/D-Yt182xdIQAAQph6XjuT.png" alt="Steel Header" width={800} height={400}/>

### **Getting LLMs to use the web is _hard_**

We want AI products that can book us a flight, find us a sublet, buy us a prom suit, and get us an interview.

But if you’ve ever tried to build an AI app that can interact with the web today, you know the headaches:

*   **Dynamic Content:** Modern sites heavily rely on client-side rendering and lazy loading, requiring scrapers to wait for page hydration and execute JS to access the full content.

*   **Complex Navigation:** Reaching desired data often involves multi-step flows, simulating user actions like clicks, typing, and handling CAPTCHAs.

*   **Authentication:** High-value data and functionality frequently sits behind auth walls, necessitating robust identity management and auto-login capabilities.

*   **Infrastructure Overhead:** Efficiently scaling and managing headless browser fleets is complex, with issues like cold starts, resource contention, and reliability eating up valuable dev cycles.

*   **Lack of Web APIs:** Many critical sites still lack API access, forcing teams to build and maintain brittle custom scrapers for each target.


This is by design. Most of the web is designed to be anti-bot and human friendly.

But what if we flipped that?

### [**​**](https://steel.dev/introduction#a-better-way-to-take-your-llms-online)**A better way to take your LLMs online**

Steel is a headless browser API that lets AI engineers:

*   Control fleets of browser sessions in the cloud via API or Python/Node SDKs

*   Easily extract page data as cleaned HTML, markdown, PDFs, or screenshots

*   Access data behind logins with persistent cookies and automatic sign-in

*   Render complex client-side content with JavaScript execution

*   Bypass anti-bot measures with rotating proxies, stealth configs, and CAPTCHA solving

*   Reduce token usage and costs by up to 80% with optimized page formats

*   Reuse session and cookie data across multiple runs

*   Debug with ease using live session viewers, replays, and embeddings


All fully managed, and ready to scale, so you can focus on building shipping product, not babysitting browsers.

Under the hood, Steel’s cloud-native platform handles all the headaches of browser infrastructure:

*   Executing JavaScript to load and hydrate pages

*   Managing credentials, sign-in flows, proxies, CAPTCHAs, and cookies

*   Horizontal browser scaling and recovering from failures

*   Optimizing data formats to reduce LLM token usage


### Get started with Sessions API

- [Overview](/overview/sessions-api/overview)
- [Quickstart](/overview/sessions-api/quickstart)
- [Connect with Puppeteer](/cookbook/puppeteer)
- [Connect with Playwright](/cookbook/playwright)
- [Connect with Selenium](/cookbook/selenium)

### Reference

- [API Reference](/api-reference)

- [Python SDK Reference](/steel-python-sdk)
- [Node SDK Reference](/steel-js-sdk)


# Legal
URL: /overview/legal

---
title: Legal
description: This page outlines the legal terms and conditions for using Steel.
sidebarTitle: Legal
isSeperator: true
llm: true
---

Please visit our latest [Terms of Service](https://docs.google.com/document/d/1VuaLxBq150cR9vyiir9B4GUsvqSu0Rd64Vtu-HiSqp8/edit?tab=t.0#heading=h.nf9mun4iq7m9)

Please visit our latest [Privacy Policy](https://docs.google.com/document/d/1q3QBkFm4ke-_oqEO3wyP5yi64TazRBt6wbvIE_Zx69A/edit?usp=sharing)


# llms-full.txt
URL: /overview/llms-full.txt

---
title: llms-full.txt
sidebarTitle: llms-full.txt
isSeperator: true
---


# Need Help?
URL: /overview/need-help

---
title: Need Help?
description: Need help with Steel? Check out our documentation or reach out to use on Discord.
sidebarTitle: Need Help?
llm: true
---

- [Overview](/overview)
- [Changelog](/changelog)
- [API Reference](/api-reference)
- [Cookbook](https://github.com/steel-dev/steel-cookbook/)
- [Discord](https://discord.gg/steel-dev)
- [Github](https://github.com/steel-dev)
- [Dashboard](https://app.steel.dev/)

We’re here to support in any way we can!

You can connect with us on:

- [Discord](https://discord.gg/steel-dev)
- [GitHub](https://github.com/steel-dev)

or send an email to our team support at [team@steel.dev](mailto:team@steel.dev?subject=Steel%20Support%20Issue)


# Pricing/Limits
URL: /overview/pricinglimits

---
title: Pricing/Limits
description: This page outlines the current pricing breakdown between free/paid plans on Steel.
sidebarTitle: Pricing/Limits
llm: true
---
**Last Edit:** May 30th, 2025

### Pricing Table

| Feature                          | Hobby ($0)     | Starter ($29) | Developer ($99) | Pro ($499/m) | Enterprise |
|----------------------------------|----------------|---------------|-----------------|--------------|------------|
| **Rates: Browser Hour**          | $0.10/hour     | $0.10/hour    | $0.08/hour      | $0.05/hour   | custom     |
| **Rates: Captcha Solves**        | —              | $4/1k         | $3.5/1k         | $3/1k        | custom     |
| **Rates: Proxy Bandwidth**       | —              | $10/GB        | $8/GB           | $5/GB        | custom     |
| **Limits: Daily Requests**       | 500            | 1,000         | unlimited       | unlimited    | unlimited  |
| **Limits: Requests per second**  | 1              | 2             | 5               | 10           | custom     |
| **Limits: Concurrent Sessions**  | 5              | 10            | 20              | 100          | custom     |
| **Limits: Data Retention**       | 24 hours       | 2 days        | 7 days          | 14 days      | unlimited  |
| **Limits: Max Session Time**     | 15 minutes     | 1 hour        | 6 hours         | 24 hours     | custom     |
| **Support: Community support**   | ✅              | ✅             | ✅               | ✅            | ✅          |
| **Support: Email support**       | —              | ✅             | ✅               | ✅            | ✅          |
| **Support: Dedicated Slack**     | —              | —             | —               | ✅            | ✅          |
| **Team members per account**     | unlimited      | unlimited     | unlimited       | unlimited    | unlimited  |


\* Browser hours are billed by the minute, rounded up.

### How Credits Work

Each plan's cost goes towards your credits within the platform. For example, if you're on the Developer Plan, every time your subscription renews, you will have $99 worth of credits to use within the platform.

Different plans offer different rates for actions within Steel, with each plan progressively getting more efficient (bigger plans = more bang for your buck).

### Pay-as-You-Go Overages

All paid plans (Starter, Developer, Pro) include pay-as-you-go overages to prevent workflow interruptions:

*   **Overage Limit:** Use up to 3x your monthly credit allocation

*   **Billing:** Overages are billed at your plan's rates at the end of each billing cycle

*   **No Interruption:** Continue building without upgrade pressure or hitting hard limits


**Example:** On the Starter Plan ($29), you can use up to $87 worth of services in a month. Your first $29 is covered by your subscription, and any usage from $29-$87 is billed as overages at Starter rates.

### Credit Equivalents by Plan

Here's roughly\* what you'd get if you spent all of your base credits on a given service:

#### Hobby Plan ($10 free credits)

*   100 browser hours


#### Starter Plan ($29 in credits)

*   290 browser hours

*   2.9GB proxy bandwidth

*   7,250 captcha solves


#### Developer Plan ($99 in credits)

*   1,238 browser hours

*   12 GB proxy bandwidth

*   28k captcha solves


#### Pro Plan ($499 in credits)

*   9,980 browser hours

*   166 GB proxy bandwidth

*   166k captcha solves


\* We say roughly because in practice you couldn't spend all your credits on one thing other than browser hours, since you need to be in a session to use proxies or captcha solves.

**_Enterprise plans offer even further cost efficiency with an annual commitment._**

[Talk to the founders](https://cal.com/hussien-hussien-fjxt3x/intro-chat-w-steel-founders)


# Steel CLI + Skill
URL: /overview/steel-cli

---
title: Steel CLI + Skill
sidebarTitle: Steel CLI + Skill
llm: true
---

## Overview

`@steel-dev/cli` lets you run full browser workflows from the terminal, end-to-end.
You can start a browser session, navigate pages, click/fill/type, extract content, and
stop the session without wiring custom browser infrastructure.

What it enables:

- Run browser automation in cloud mode (default) or self-hosted/local mode
- Drive pages with terminal-first browser commands (`open`, `snapshot`, `fill`, `click`, etc.)
- Use API tools for `scrape`, `screenshot`, and `pdf`
- Bootstrap projects quickly with `forge` and run templates instantly with `run`

Under the hood, `steel browser` is directly integrated with the `agent-browser` runtime.
That means Steel adds session lifecycle, auth, and endpoint routing while preserving
familiar browser command behavior.

- GitHub: [steel-dev/cli](https://github.com/steel-dev/cli)
- Package: [npmjs.com/package/@steel-dev/cli](https://www.npmjs.com/package/@steel-dev/cli)

## Documentation Index (for Agents)

If you are using an AI agent and want a complete docs index before exploring pages:

- `https://docs.steel.dev/llms-full.txt`

This returns a flattened, agent-friendly text map of the docs site.

## Installation

Install with the official script (recommended):

```bash Terminal
curl -fsS https://setup.steel.dev | sh
```

This installs the native `steel` binary to `~/.steel/bin` and runs `steel init`
to log you in, verify connectivity, and install coding-agent skills.

Alternative: install via npm (wraps the native binary):

```bash Terminal
npm i -g @steel-dev/cli
```

## Quick Start

### Cloud Mode (Default)

```bash Terminal -wc
steel login
steel browser start --session my-job
steel browser open https://example.com --session my-job
steel browser snapshot -i --session my-job
steel browser stop --session my-job
```

### Self-Hosted Endpoint

```bash Terminal
steel browser start --api-url https://steel.your-domain.dev/v1 --session my-job
steel browser open https://example.com --api-url https://steel.your-domain.dev/v1 --session my-job
```

### Local Runtime (`localhost`) Flow

```bash Terminal
steel dev install
steel dev start
steel browser start --local --session local-job
steel browser open https://example.com --session local-job
steel browser stop --session local-job
steel dev stop
```

## Skills for Coding Agents

Steel ships a dedicated skill package for browser workflows:

- [skills/steel-browser](https://github.com/steel-dev/cli/tree/main/skills/steel-browser)

This is designed for coding agents, including:

- Codex
- OpenCode
- OpenClaw
- Claude Code

Install from GitHub:

```bash Terminal
npx skills add github:steel-dev/cli/skills/steel-browser
```

Or from a local checkout:

```bash Terminal
npx skills add ./skills/steel-browser
```

After installation, restart your agent client so it can discover newly installed skills.

What this skill gives agents:

- Mode-aware command planning (cloud vs self-hosted)
- Named-session lifecycle discipline (`start -> work -> stop`)
- Reliable command patterns for `steel browser` passthrough actions
- Migration guidance from `agent-browser`
- Troubleshooting playbooks for auth/session/CAPTCHA failures

### Typical Agent Skill Workflow

Most agent loops follow this pattern:

1. Start or attach a named session.
2. Open a page and inspect interactable elements (`snapshot -i`).
3. Perform actions (`fill`, `select`, `check`, `click`).
4. Wait for the post-action state and verify output.
5. Stop the session when done.

```bash Terminal
SESSION="signup-demo-$(date +%s)"
steel browser start --session "$SESSION"
steel browser open https://example.com/signup --session "$SESSION"
steel browser snapshot -i --session "$SESSION"
steel browser fill @e1 "Jane Doe" --session "$SESSION"
steel browser fill @e2 "jane@example.com" --session "$SESSION"
steel browser select @e3 "California" --session "$SESSION"
steel browser check @e4 --session "$SESSION"
steel browser click @e5 --session "$SESSION"
steel browser wait --load networkidle --session "$SESSION"
steel browser stop --session "$SESSION"
```

If you already know upstream `agent-browser`, the behavior is typically command-prefix only:

```bash Terminal
agent-browser open https://example.com/signup
agent-browser snapshot -i
agent-browser fill @e1 "Jane Doe"
agent-browser fill @e2 "jane@example.com"
agent-browser select @e3 "California"
agent-browser check @e4
agent-browser click @e5
agent-browser wait --load networkidle
```

## Command Model

### Steel-Owned Browser Lifecycle Commands

- `steel browser start`
- `steel browser stop`
- `steel browser sessions`
- `steel browser live`
- `steel browser captcha solve`

### Inherited Browser Commands (Passthrough)

All non-lifecycle `steel browser <command>` calls are routed through the vendored
`agent-browser` runtime.

Migration is usually command-prefix only:

- Before: `agent-browser <command> ...`
- After: `steel browser <command> ...`

### Essential Inherited Commands

These are the most common inherited commands agents use:

- Page navigation: `open`, `back`, `forward`, `reload`
- Page understanding: `snapshot`, `snapshot -i`
- Interaction: `click`, `fill`, `type`, `select`, `check`, `press`, `hover`
- Data retrieval: `get text`, `get html`, `get title`, `get url`
- Synchronization: `wait`, `wait --load networkidle`, `wait --text`
- Debugging: `screenshot`, `errors`, `console`

Use command help directly when needed:

```bash Terminal
steel browser --help
steel browser click --help
steel browser wait --help
```

For full command references:
- [Steel browser commands reference](https://github.com/steel-dev/cli/blob/main/docs/references/steel-browser-commands.md)
- [Steel browser session lifecycle reference](https://github.com/steel-dev/cli/blob/main/docs/references/steel-browser.md)

## Command Overview

| Group | Commands |
|---|---|
| Onboarding | `init`, `forge` |
| Browser lifecycle | `browser start`, `browser stop`, `browser sessions`, `browser live`, `browser captcha solve` |
| Browser passthrough | `steel browser <inherited-command>` |
| API tools | `scrape`, `screenshot`, `pdf` |
| Local runtime | `dev install`, `dev start`, `dev stop` |
| Profiles | `profile import`, `profile sync`, `profile list`, `profile delete` |
| Credentials | `credentials list`, `credentials create`, `credentials update`, `credentials delete` |
| Account + utility | `login`, `logout`, `config`, `doctor`, `cache`, `update` |

## Common Workflows

### 1. Named Session Lifecycle

```bash Terminal
SESSION="job-$(date +%s)"
steel browser start --session "$SESSION"
steel browser open https://example.com --session "$SESSION"
steel browser snapshot -i --session "$SESSION"
steel browser get title --session "$SESSION"
steel browser stop --session "$SESSION"
```

### 2. CAPTCHA-Aware Sessions

```bash Terminal
# Manual solve mode
steel browser start --session my-job --session-solve-captcha
steel browser captcha solve --session my-job

# Auto solve mode (stealth preset)
steel browser start --session my-job --stealth
```

### 3. `agent-browser` Migration

```bash Terminal
# Before
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e3

# After
steel browser open https://example.com
steel browser snapshot -i
steel browser click @e3
```

### 4. API Tool Commands

```bash Terminal
# Scrape (markdown-first output by default)
steel scrape https://example.com

# Screenshot
steel screenshot https://example.com --full-page

# PDF
steel pdf https://example.com
```

## `forge` (Templates)

Use `forge` to scaffold a project from a template.

```bash Terminal
# Scaffold a project
steel forge playwright --name my-bot
```

List all templates and flags:

```bash Terminal
steel forge --help
```

## Endpoint Resolution

For browser lifecycle, passthrough bootstrap, and API tools (`scrape`, `screenshot`, `pdf`),
endpoint selection is deterministic.

Self-hosted precedence:

1. `--api-url <url>`
2. `STEEL_BROWSER_API_URL`
3. `STEEL_LOCAL_API_URL`
4. `browser.apiUrl` in `~/.config/steel/config.json`
5. `http://localhost:3000/v1`

Cloud precedence:

1. `STEEL_API_URL`
2. `https://api.steel.dev/v1`

Attach-flag override:

- If `--cdp` or `--auto-connect` is provided, Steel skips bootstrap injection and forwards
  passthrough arguments unchanged.

## Auth, Config, and Updates

```bash Terminal
steel login
steel config
steel logout
steel cache --clean
steel update
steel update --check
steel update --force
```

Disable auto-update checks (24-hour cache window):

```bash Terminal
steel scrape https://example.com --no-update-check
STEEL_CLI_SKIP_UPDATE_CHECK=true steel scrape https://example.com
CI=true steel scrape https://example.com
NODE_ENV=test steel scrape https://example.com
```

## Runtime and Output Notes

- `steel scrape` defaults to markdown-first output; use `--raw` for full JSON payload.
- `steel browser start` and `steel browser sessions` return display-safe `connect_url` values
  with sensitive query parameters redacted.
- Browser command paths bypass auto-update checks to reduce interactive latency.

## Troubleshooting

- `Missing browser auth...`: run `steel login` or set `STEEL_API_KEY`.
- `Failed to reach Steel session API ...`: confirm mode and endpoint settings (`--local`,
  `--api-url`, env vars).
- Session reuse issues: use a consistent `--session <name>` across every step.
- Local runtime issues: run `steel dev install` once, then `steel dev start`.
- Stale state: run `steel browser stop --all` and start a fresh named session.

## References

- [Steel CLI README](https://github.com/steel-dev/cli/blob/main/README.md)
- [Generated CLI Reference](https://github.com/steel-dev/cli/blob/main/docs/cli-reference.md)
- [Steel Browser Reference](https://github.com/steel-dev/cli/blob/main/docs/references/steel-browser.md)
- [Migration Guide (`agent-browser` -> `steel browser`)](https://github.com/steel-dev/cli/blob/main/docs/migration-agent-browser.md)
- [Steel Browser Skill Package](https://github.com/steel-dev/cli/tree/main/skills/steel-browser)


# Overview
URL: /integrations/agentkit/agentkit-overview

---
title: Overview
sidebarTitle: Overview
description: AgentKit is a TypeScript library for creating and orchestrating AI agents, from single-model calls to multi-agent networks with deterministic routing, shared state, and rich tooling via MCP.
llm: true
---
#### Overview

The AgentKit integration connects Steel’s cloud browser sessions with AgentKit’s **Networks**, **Routers**, and **Agents**, so you can:

*   Drive Steel browsers from AgentKit agents and tools (navigate, search, fill forms, extract results)

*   Orchestrate multi-agent **Networks** with shared **State** and code/LLM-based **Routers**

*   Plug in MCP servers as tools for powerful real-world actions (DBs, apps, services)

*   Stream live tokens/steps to your UI and capture traces locally during development

*   Mix deterministic flows with autonomous handoffs for reliable, production-grade automations


Combined, Steel + AgentKit gives you scalable web automation with sandboxed, anti-bot capable browsers and fault-tolerant orchestration.

#### Requirements

*   **Steel API Key**: Active Steel subscription to create/manage browser sessions

*   **Node.js**: v20+ recommended

*   **Package Setup**: `npm i @inngest/agent-kit inngest` (AgentKit ≥ v0.9.0 requires `inngest` alongside)

*   **Model Providers**: OpenAI, Anthropic, Google Gemini, and OpenAI-compatible endpoints

*   **Optional**: MCP servers (e.g., via Smithery), search tools, vector stores, observability


#### Documentation

[Quickstart Guide](/integrations/agentkit/quickstart) → Build a simple AgentKit **Network** that routes tasks and controls a Steel browser session end-to-end.

#### Additional Resources

*   [AgentKit Documentation](https://agentkit.inngest.com/overview) – Concepts for Agents, Networks, State, and Routers

*   [Examples Gallery](https://agentkit.inngest.com/examples/overview) – Starter projects (support agent, SWE-bench, coding agent, web search)

*   [LLMs Docs Bundle](https://agentkit.inngest.com/llms-full.txt) – Markdown doc set for IDEs/LLMs

*   [Inngest Dev Server (local tracing)](https://agentkit.inngest.com/getting-started/local-development) – Live traces and I/O logs

*   [Steel Sessions API Reference](https://docs.steel.dev/api-reference) – Programmatic session control for Steel browsers

*   [Community Discord](https://www.inngest.com/discord) – Discuss MCP, routing patterns, and production setups


# Quickstart
URL: /integrations/agentkit/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: This guide shows how to use AgentKit with Steel to build a small network that browses Hacker News in a live cloud browser via CDP, filters stories by topic, and returns concise picks.
llm: true
---

#### Prerequisites
:::prerequisites
*   Node.js **v20+**

*   Steel API key (get one at [app.steel.dev](http://app.steel.dev/))

*   OpenAI API key (get one at [platform.openai.com](http://platform.openai.com/))
:::

#### Step 1: Project Setup

Create a Typescript project and starter files.

```bash Terminal -wc
mkdir steel-agentkit-hn && \
cd steel-agentkit-hn && \
npm init -y && \
npm install -D typescript @types/node ts-node && \
npx tsc --init && \
npm pkg set scripts.start="ts-node index.ts" && \
touch index.ts .env

npm install steel-sdk @inngest/agent-kit zod playwright dotenv
```


Add your API keys to `.env`:

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
OPENAI_API_KEY=your-openai-api-key-here
```


#### Step 2: Create a browsing tool

We’ll define a custom **AgentKit tool**

```typescript Typescript -wcn -f index.ts
import dotenv from "dotenv";
dotenv.config();

import { z } from "zod";
import { chromium } from "playwright";
import Steel from "steel-sdk";
import {
  openai,
  createAgent,
  createNetwork,
  createTool,
} from "@inngest/agent-kit";

const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "your-openai-api-key-here";

const client = new Steel({ steelAPIKey: STEEL_API_KEY });

const browseHackerNews = createTool({
  name: "browse_hacker_news",
  description:
    "Fetch Hacker News stories (top/best/new) and optionally filter by topics",
  parameters: z.object({
    section: z.enum(["top", "best", "new"]).default("top"),
    topics: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  handler: async ({ section, topics, limit }, { step }) => {
    if (STEEL_API_KEY === "your-steel-api-key-here") {
      throw new Error("Set STEEL_API_KEY");
    }
    return await step?.run("browse-hn", async () => {
      const session = await client.sessions.create({});
      const browser = await chromium.connectOverCDP(
        `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
      );
      try {
        const context = browser.contexts()[0];
        const page = context.pages()[0];
        const base = "https://news.ycombinator.com";
        const url =
          section === "best"
            ? `${base}/best`
            : section === "new"
            ? `${base}/newest`
            : base;

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Extract rows client-side for speed & resilience
        const items = await page.evaluate((maxItems: number) => {
          const rows = Array.from(document.querySelectorAll("tr.athing"));
          const take = Math.min(maxItems * 2, rows.length);
          const out = [] as Array<{
            rank: number;
            title: string;
            url: string;
            site: string | null;
            points: number;
            comments: number;
            itemId: string;
          }>;
          for (let i = 0; i < take; i++) {
            const row = rows[i] as HTMLElement;
            const titleEl = row.querySelector(
              ".titleline > a"
            ) as HTMLAnchorElement | null;
            const sub = row.nextElementSibling as HTMLElement | null;
            const scoreEl = sub?.querySelector(".score");
            const commentsLink = sub?.querySelector(
              'a[href*="item?id="]:last-child'
            ) as HTMLAnchorElement | null;

            const rankText = row.querySelector(".rank")?.textContent || "";
            const rank =
              parseInt(rankText.replace(".", "").trim(), 10) || i + 1;
            const title = titleEl?.textContent?.trim() || "";
            const url = titleEl?.getAttribute("href") || "";
            const site = row.querySelector(".sitestr")?.textContent || null;
            const points = scoreEl?.textContent
              ? parseInt(scoreEl.textContent, 10)
              : 0;
            const commentsText = commentsLink?.textContent || "";
            const commentsNum = /\d+/.test(commentsText)
              ? parseInt((commentsText.match(/\d+/) || ["0"])[0], 10)
              : 0;
            const itemId = row.getAttribute("id") || "";
            out.push({ rank, title, url, site, points, comments: commentsNum, itemId });
          }
          return out;
        }, limit);

        // Optional topic filtering, then dedupe + cap
        const filtered =
          topics && topics.length > 0
            ? items.filter((it) => {
                const t = it.title.toLowerCase();
                return topics.some((kw) => t.includes(kw.toLowerCase()));
              })
            : items;

        const deduped: typeof filtered = [];
        const seen = new Set<string>();
        for (const it of filtered) {
          const key = `${it.title}|${it.url}`;
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(it);
          }
          if (deduped.length >= limit) break;
        }
        return deduped.slice(0, limit);
      } finally {
        // Always clean up cloud resources
        try {
          await browser.close();
        } finally {
          await client.sessions.release(session.id);
        }
      }
    });
  },
});

```


#### Step 3: Build the Agenth & Network

Wire the tool into an agent and run it inside a small network with your default model.

```typescript Typescript -wcn -f index.ts
const hnAgent = createAgent({
  name: "hn_curator",
  description: "Curates interesting Hacker News stories by topic",
  system:
    "Surface novel, high-signal Hacker News stories. Favor technical depth, originality, and relevance to requested topics. Use the tool to browse and return concise picks.",
  tools: [browseHackerNews],
});

const hnNetwork = createNetwork({
  name: "hacker-news-network",
  description: "Network for curating Hacker News stories",
  agents: [hnAgent],
  maxIter: 2,
  defaultModel: openai({
    model: "gpt-5-nano",
  }),
});
```


#### Step 5: Run the network

Add a small `main()` that checks env vars, runs the network, and prints results.

```typescript Typescript -wcn -f index.ts
async function main() {
  console.log("🚀 Steel + Agent Kit Starter");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key");
    console.warn("   Get your API key at: https://app.steel.dev/settings/api-keys");
    return;
  }
  if (OPENAI_API_KEY === "your-openai-api-key-here") {
    console.warn("⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key");
    console.warn("   Get your API key at: https://platform.openai.com/api-keys");
    return;
  }

  try {
    console.log("\nRunning HN curation...");
    const run = await hnNetwork.run(
      "Curate 5 interesting Hacker News stories about AI, TypeScript, and tooling. Prefer 'best' if relevant. Return title, url, points."
    );
    const results = (run as any).state?.results ?? [];
    console.log("\nResults:\n" + JSON.stringify(results, null, 2));
  } catch (err) {
    console.error("An error occurred:", err);
  } finally {
    console.log("Done!");
  }
}

main();
```


#### Run it:

Open your console output to see your curated results. You can also watch the live Steel session from your Steel dashboard.

#### Complete Example

Paste the full **index.ts** below and run `npm run start`:

```typescript Typescript -wcn -f index.ts
import dotenv from "dotenv";
dotenv.config();
import { z } from "zod";
import { chromium } from "playwright";
import Steel from "steel-sdk";
import {
  openai,
  createAgent,
  createNetwork,
  createTool,
} from "@inngest/agent-kit";

// Replace with your own API keys
const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "your-openai-api-key-here";

const client = new Steel({ steelAPIKey: STEEL_API_KEY });

const browseHackerNews = createTool({
  name: "browse_hacker_news",
  description:
    "Fetch Hacker News stories (top/best/new) and optionally filter by topics",
  parameters: z.object({
    section: z.enum(["top", "best", "new"]).default("top"),
    topics: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  handler: async ({ section, topics, limit }, { step }) => {
    if (STEEL_API_KEY === "your-steel-api-key-here") {
      throw new Error("Set STEEL_API_KEY");
    }
    return await step?.run("browse-hn", async () => {
      const session = await client.sessions.create({});
      const browser = await chromium.connectOverCDP(
        `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
      );
      try {
        const context = browser.contexts()[0];
        const page = context.pages()[0];
        const base = "https://news.ycombinator.com";
        const url =
          section === "best"
            ? `${base}/best`
            : section === "new"
              ? `${base}/newest`
              : base;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const items = await page.evaluate((maxItems: number) => {
          const rows = Array.from(document.querySelectorAll("tr.athing"));
          const take = Math.min(maxItems * 2, rows.length);
          const out = [] as Array<{
            rank: number;
            title: string;
            url: string;
            site: string | null;
            points: number;
            comments: number;
            itemId: string;
          }>;
          for (let i = 0; i < take; i++) {
            const row = rows[i] as HTMLElement;
            const titleEl = row.querySelector(
              ".titleline > a"
            ) as HTMLAnchorElement | null;
            const sub = row.nextElementSibling as HTMLElement | null;
            const scoreEl = sub?.querySelector(".score");
            const commentsLink = sub?.querySelector(
              'a[href*="item?id="]:last-child'
            ) as HTMLAnchorElement | null;
            const rankText = row.querySelector(".rank")?.textContent || "";
            const rank =
              parseInt(rankText.replace(".", "").trim(), 10) || i + 1;
            const title = titleEl?.textContent?.trim() || "";
            const url = titleEl?.getAttribute("href") || "";
            const site = row.querySelector(".sitestr")?.textContent || null;
            const points = scoreEl?.textContent
              ? parseInt(scoreEl.textContent, 10)
              : 0;
            const commentsText = commentsLink?.textContent || "";
            const commentsNum = /\d+/.test(commentsText)
              ? parseInt((commentsText.match(/\d+/) || ["0"])[0], 10)
              : 0;
            const itemId = row.getAttribute("id") || "";
            out.push({
              rank,
              title,
              url,
              site,
              points,
              comments: commentsNum,
              itemId,
            });
          }
          return out;
        }, limit);
        const filtered =
          topics && topics.length > 0
            ? items.filter((it) => {
                const t = it.title.toLowerCase();
                return topics.some((kw) => t.includes(kw.toLowerCase()));
              })
            : items;
        const deduped = [] as typeof filtered;
        const seen = new Set<string>();
        for (const it of filtered) {
          const key = `${it.title}|${it.url}`;
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(it);
          }
          if (deduped.length >= limit) break;
        }
        return deduped.slice(0, limit);
      } finally {
        try {
          await browser.close();
        } finally {
          await client.sessions.release(session.id);
        }
      }
    });
  },
});

const hnAgent = createAgent({
  name: "hn_curator",
  description: "Curates interesting Hacker News stories by topic",
  system:
    "Surface novel, high-signal Hacker News stories. Favor technical depth, originality, and relevance to requested topics. Use the tool to browse and return concise picks.",
  tools: [browseHackerNews],
});

const hnNetwork = createNetwork({
  name: "hacker-news-network",
  description: "Network for curating Hacker News stories",
  agents: [hnAgent],
  maxIter: 2,
  defaultModel: openai({
    model: "gpt-5-nano",
  }),
});

async function main() {
  console.log("🚀 Steel + Agent Kit Starter");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
    );
    console.warn(
      "   Get your API key at: https://app.steel.dev/settings/api-keys"
    );
    return;
  }

  if (OPENAI_API_KEY === "your-openai-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key"
    );
    console.warn(
      "   Get your API key at: https://platform.openai.com/api-keys"
    );
    return;
  }

  try {
    console.log("\nRunning HN curation...");
    const run = await hnNetwork.run(
      "Curate 5 interesting Hacker News stories about AI, TypeScript, and tooling. Prefer 'best' if relevant. Return title, url, points."
    );
    const results = (run as any).state?.results ?? [];
    console.log("\nResults:\n" + JSON.stringify(results, null, 2));
  } catch (err) {
    console.error("An error occurred:", err);
  } finally {
    console.log("Done!");
  }
}

main();

```


#### Customize the prompt

Try adjusting the network input:

```typescript Typescript -wcn -f main.ts
await hnNetwork.run(
  "Curate 8 stories about WebAssembly, Edge runtimes, and performance. Use 'new' if there are fresh posts. Return title, url, site, points, comments."
);
```


#### Next steps

*   AgentKit Docs: [https://agentkit.inngest.com/overview](https://agentkit.inngest.com/overview)

*   Examples Gallery: [https://agentkit.inngest.com/examples/overview](https://agentkit.inngest.com/examples/overview)

*   Steel Sessions API: [/overview/sessions-api/overview](/overview/sessions-api/overview)

*   Session Lifecycle: [https://docs.steel.dev/overview/sessions-api/session-lifecycle](/overview/sessions-api/session-lifecycle)

*   Steel Node SDK: [https://github.com/steel-dev/steel-node](https://github.com/steel-dev/steel-node)


# Overview
URL: /integrations/agno/agno-overview

---
title: Overview
sidebarTitle: Overview
description: Agno is a full-stack framework for building multi-agent systems with shared memory, knowledge, and reasoning.
llm: true
---
#### Overview

The Agno integration connects Steel’s cloud browser infrastructure with Agno’s agent and team architecture, so you can:

*   Launch and control Steel browser sessions as Agno tools inside single agents or coordinated agent teams

*   Automate multi-step web workflows (navigate, search, fill forms, extract data) with shared context and memory

*   Combine Agentic RAG and web automation for up-to-date answers using your preferred vector stores

*   Use reasoning (reasoning models or Agno’s ReasoningTools) for more reliable plans and actions

*   Return structured outputs (JSON/typed) and monitor runs end-to-end


Agno is model-agnostic (23+ providers supported) and natively multi-modal, which pairs well with Steel’s reliable, sandboxed browsers, proxy management, and anti-bot capabilities.

#### Requirements

*   **Steel API Key**: Active Steel subscription to create and manage browser sessions

*   **Model Provider Key(s)**: e.g., OpenAI, Anthropic, etc. (Agno supports many providers)

*   **Python Environment**: Agno is Python-first (works great with modern Python runtimes)

*   **Optional Storage**: Vector DB + memory/session storage for Agentic RAG and long-term memory


#### Documentation

[Quickstart Guide](/integrations/agno/quickstart) → Build your first Agno agent that controls a Steel browser session and returns structured results.

#### Additional Resources

*   [Agno Documentation](https://docs.agno.com/) – Concepts, APIs, and examples for agents, teams, memory, and reasoning

*   [Steel Sessions API Reference](/api-reference) – Manage Steel browser sessions programmatically

*   [Community Discord](https://discord.gg/steel-dev) – Get help, share recipes, and discuss best practices


# Quickstart
URL: /integrations/agno/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: This guide walks you through connecting Agno with Steel by adding a Playwright-powered Steel toolkit and running an agent that browses and extracts content from live websites.
llm: true
---

#### Prerequisites

Make sure you have:

*   Python **3.10+**

*   Steel API key (get one at [**app.steel.dev**](http://app.steel.dev/))

*   OpenAI API key (Agno v2 requires an explicit model — this starter uses OpenAI)


#### Step 1: Project setup

Create and activate a virtual environment, then install dependencies:

```package-install python
"agno>=2.5,<3" "openai>=2,<3" steel-sdk python-dotenv playwright
```

Create a `.env` file with your keys and a default task:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
TASK=Go to https://quotes.toscrape.com and: 1. Get the first 3 quotes with authors 2. Navigate to page 2 3. Get 2 more quotes from page 2
```


#### Step 2: Add a Steel toolkit and run an Agno Agent

First, define a toolkit that wraps Steel’s browser sessions and Playwright.

```python Python -wcn -f main.py
import os
import json
from typing import Any, Dict, List, Optional
from agno.tools import Toolkit
from agno.utils.log import log_debug, logger
from playwright.sync_api import sync_playwright
from steel import Steel


class SteelTools(Toolkit):
    def __init__(
        self,
        api_key: Optional[str] = None,
        **kwargs,
    ):
        """Initialize SteelTools.

        Args:
            api_key (str, optional): Steel API key (defaults to STEEL_API_KEY env var).
        """
        self.api_key = api_key or os.getenv("STEEL_API_KEY")
        if not self.api_key:
            raise ValueError(
                "STEEL_API_KEY is required. Please set the STEEL_API_KEY environment variable."
            )

        self.client = Steel(steel_api_key=self.api_key)

        self._playwright = None
        self._browser = None
        self._page = None
        self._session = None
        self._connect_url = None

        tools: List[Any] = []
        tools.append(self.navigate_to)
        tools.append(self.screenshot)
        tools.append(self.get_page_content)
        tools.append(self.close_session)

        super().__init__(name="steel_tools", tools=tools, **kwargs)

    def _ensure_session(self):
        """Ensures a Steel session exists, creating one if needed."""
        if not self._session:
            try:
                self._session = self.client.sessions.create()  # type: ignore
                if self._session:
                    self._connect_url = f"{self._session.websocket_url}&apiKey={self.api_key}"  # type: ignore
                    log_debug(f"Created new Steel session with ID: {self._session.id}")
            except Exception as e:
                logger.error(f"Failed to create Steel session: {str(e)}")
                raise

    def _initialize_browser(self, connect_url: Optional[str] = None):
        """
        Initialize browser connection if not already initialized.
        Use provided connect_url or ensure we have a session with a connect_url
        """
        if connect_url:
            self._connect_url = connect_url if connect_url else ""  # type: ignore
        elif not self._connect_url:
            self._ensure_session()

        if not self._playwright:
            self._playwright = sync_playwright().start()  # type: ignore
            if self._playwright:
                self._browser = self._playwright.chromium.connect_over_cdp(self._connect_url)
            context = self._browser.contexts[0] if self._browser else ""
            self._page = context.pages[0] or context.new_page()  # type: ignore

    def _cleanup(self):
        """Clean up browser resources."""
        if self._browser:
            self._browser.close()
            self._browser = None
        if self._playwright:
            self._playwright.stop()
            self._playwright = None
        self._page = None

    def _create_session(self) -> Dict[str, str]:
        """Creates a new Steel browser session.

        Returns:
            Dictionary containing session details including session_id and connect_url.
        """
        self._ensure_session()
        return {
            "session_id": self._session.id if self._session else "",
            "connect_url": self._connect_url or "",
        }

    def navigate_to(self, url: str, connect_url: Optional[str] = None) -> str:
        """Navigates to a URL.

        Args:
            url (str): The URL to navigate to
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            JSON string with navigation status
        """
        try:
            self._initialize_browser(connect_url)
            if self._page:
                self._page.goto(url, wait_until="networkidle")
            result = {"status": "complete", "title": self._page.title() if self._page else "", "url": url}
            return json.dumps(result)
        except Exception as e:
            self._cleanup()
            raise e

    def screenshot(self, path: str, full_page: bool = True, connect_url: Optional[str] = None) -> str:
        """Takes a screenshot of the current page.

        Args:
            path (str): Where to save the screenshot
            full_page (bool): Whether to capture the full page
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            JSON string confirming screenshot was saved
        """
        try:
            self._initialize_browser(connect_url)
            if self._page:
                self._page.screenshot(path=path, full_page=full_page)
            return json.dumps({"status": "success", "path": path})
        except Exception as e:
            self._cleanup()
            raise e

    def get_page_content(self, connect_url: Optional[str] = None) -> str:
        """Gets the HTML content of the current page.

        Args:
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            The page HTML content
        """
        try:
            self._initialize_browser(connect_url)
            return self._page.content() if self._page else ""
        except Exception as e:
            self._cleanup()
            raise e

    def close_session(self) -> str:
        """Closes the current Steel browser session and cleans up resources.

        Returns:
            JSON string with closure status
        """
        try:
            self._cleanup()

            try:
                if self._session:
                    self.client.sessions.release(self._session.id)  # type: ignore
            except Exception as release_error:
                logger.warning(f"Failed to release Steel session: {str(release_error)}")

            self._session = None
            self._connect_url = None

            return json.dumps(
                {
                    "status": "closed",
                    "message": "Browser resources cleaned up. Steel session released if active.",
                }
            )
        except Exception as e:
            return json.dumps({"status": "warning", "message": f"Cleanup completed with warning: {str(e)}"})

```


#### Step 3: Register a Steel toolkit and run an Agno Agent

Create an **Agent** that uses your toolkit to perform multi-step tasks.

```python Python -wcn -f main.py
import os
from dotenv import load_dotenv
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from steel_tools import SteelTools

load_dotenv()

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"
TASK = os.getenv("TASK") or "Go to https://quotes.toscrape.com and get some quotes"

def main():
    tools = SteelTools(api_key=STEEL_API_KEY)

    agent = Agent(
        name="Web Scraper",
        model=OpenAIChat(id="gpt-5-nano", api_key=OPENAI_API_KEY),
        tools=[tools],
        instructions=[
            "Use the tools to browse and extract content.",
            "Format results cleanly as markdown.",
            "Always close sessions when done.",
        ],
        markdown=True,
    )

    response = agent.run(TASK)
    print("\nResults:\n")
    print(response.content)

    tools.close_session()

if __name__ == "__main__":
    main()

```


#### Run it:

You’ll see the agent connect to a live Steel browser via CDP, navigate to the site, and extract content. A session viewer URL is printed in your Steel dashboard for live/replay views.

#### Complete Example

Paste the full script below into `main.py` and run:

```python Python -wcn -f main.py
import json
import os
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from playwright.sync_api import sync_playwright
from steel import Steel

from dotenv import load_dotenv

load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"

# Replace with your own task
TASK = os.getenv("TASK") or "Go to https://quotes.toscrape.com and: 1. Get the first 3 quotes with authors 2. Navigate to page 2 3. Get 2 more quotes from page 2"

class SteelTools(Toolkit):
    def __init__(
        self,
        api_key: Optional[str] = None,
        **kwargs,
    ):
        """Initialize SteelTools.

        Args:
            api_key (str, optional): Steel API key (defaults to STEEL_API_KEY env var).
        """
        self.api_key = api_key or os.getenv("STEEL_API_KEY")
        if not self.api_key:
            raise ValueError(
                "STEEL_API_KEY is required. Please set the STEEL_API_KEY environment variable."
            )

        self.client = Steel(steel_api_key=self.api_key)

        self._playwright = None
        self._browser = None
        self._page = None
        self._session = None
        self._connect_url = None

        tools: List[Any] = []
        tools.append(self.navigate_to)
        tools.append(self.screenshot)
        tools.append(self.get_page_content)
        tools.append(self.close_session)

        super().__init__(name="steel_tools", tools=tools, **kwargs)

    def _ensure_session(self):
        """Ensures a Steel session exists, creating one if needed."""
        if not self._session:
            try:
                self._session = self.client.sessions.create()  # type: ignore
                if self._session:
                    self._connect_url = f"{self._session.websocket_url}&apiKey={self.api_key}"  # type: ignore
                    log_debug(f"Created new Steel session with ID: {self._session.id}")
            except Exception as e:
                logger.error(f"Failed to create Steel session: {str(e)}")
                raise

    def _initialize_browser(self, connect_url: Optional[str] = None):
        """
        Initialize browser connection if not already initialized.
        Use provided connect_url or ensure we have a session with a connect_url
        """
        if connect_url:
            self._connect_url = connect_url if connect_url else ""  # type: ignore
        elif not self._connect_url:
            self._ensure_session()

        if not self._playwright:
            self._playwright = sync_playwright().start()  # type: ignore
            if self._playwright:
                self._browser = self._playwright.chromium.connect_over_cdp(self._connect_url)
            context = self._browser.contexts[0] if self._browser else ""
            self._page = context.pages[0] or context.new_page()  # type: ignore

    def _cleanup(self):
        """Clean up browser resources."""
        if self._browser:
            self._browser.close()
            self._browser = None
        if self._playwright:
            self._playwright.stop()
            self._playwright = None
        self._page = None

    def _create_session(self) -> Dict[str, str]:
        """Creates a new Steel browser session.

        Returns:
            Dictionary containing session details including session_id and connect_url.
        """
        self._ensure_session()
        return {
            "session_id": self._session.id if self._session else "",
            "connect_url": self._connect_url or "",
        }

    def navigate_to(self, url: str, connect_url: Optional[str] = None) -> str:
        """Navigates to a URL.

        Args:
            url (str): The URL to navigate to
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            JSON string with navigation status
        """
        try:
            self._initialize_browser(connect_url)
            if self._page:
                self._page.goto(url, wait_until="networkidle")
            result = {"status": "complete", "title": self._page.title() if self._page else "", "url": url}
            return json.dumps(result)
        except Exception as e:
            self._cleanup()
            raise e

    def screenshot(self, path: str, full_page: bool = True, connect_url: Optional[str] = None) -> str:
        """Takes a screenshot of the current page.

        Args:
            path (str): Where to save the screenshot
            full_page (bool): Whether to capture the full page
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            JSON string confirming screenshot was saved
        """
        try:
            self._initialize_browser(connect_url)
            if self._page:
                self._page.screenshot(path=path, full_page=full_page)
            return json.dumps({"status": "success", "path": path})
        except Exception as e:
            self._cleanup()
            raise e

    def get_page_content(self, connect_url: Optional[str] = None) -> str:
        """Gets the HTML content of the current page.

        Args:
            connect_url (str, optional): The connection URL from an existing session

        Returns:
            The page HTML content
        """
        try:
            self._initialize_browser(connect_url)
            return self._page.content() if self._page else ""
        except Exception as e:
            self._cleanup()
            raise e

    def close_session(self) -> str:
        """Closes the current Steel browser session and cleans up resources.

        Returns:
            JSON string with closure status
        """
        try:
            self._cleanup()

            try:
                if self._session:
                    self.client.sessions.release(self._session.id)  # type: ignore
            except Exception as release_error:
                logger.warning(f"Failed to release Steel session: {str(release_error)}")

            self._session = None
            self._connect_url = None

            return json.dumps(
                {
                    "status": "closed",
                    "message": "Browser resources cleaned up. Steel session released if active.",
                }
            )
        except Exception as e:
            return json.dumps({"status": "warning", "message": f"Cleanup completed with warning: {str(e)}"})

def main():
    print("🚀 Steel + Agno Starter")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    if OPENAI_API_KEY == "your-openai-api-key-here":
        print("⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key")
        print("   Get your API key at: https://platform.openai.com/api-keys")
        return

    tools = SteelTools(api_key=STEEL_API_KEY)
    agent = Agent(
        name="Web Scraper",
        model=OpenAIChat(id="gpt-5-nano", api_key=OPENAI_API_KEY),
        tools=[tools],
        instructions=[
            "Extract content clearly and format nicely",
            "Always close sessions when done",
        ],
        markdown=True,
    )

    try:
        response = agent.run(TASK)
        print("\nResults:\n")
        print(response.content)
    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        tools.close_session()
        print("Done!")

if __name__ == "__main__":
    main()

```

#### Customizing your agent’s task

Try modifying the `TASK` in your `.env`:

```env ENV -wcn -f .env
# Crawl a product page and extract specs
TASK=Go to https://example.com/product/123 and extract the product name, price, and 5 key specs.

# Capture a screenshot-only workflow
TASK=Go to https://news.ycombinator.com, take a full-page screenshot, and return the page title.

# Multi-step navigation
TASK=Open https://docs.steel.dev, search for "session lifecycle", and summarize the key steps with anchors.
```


#### Next Steps

*   **Agno Docs**: [https://docs.agno.com](https://docs.agno.com/)

*   **Session Lifecycles**: [https://docs.steel.dev/overview/sessions-api/session-lifecycle](/overview/sessions-api/session-lifecycle)

*   **Steel Sessions API**: [https://docs.steel.dev/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **Steel Python SDK**: [https://github.com/steel-dev/steel-python](https://github.com/steel-dev/steel-python)

*   **Playwright Docs**: [https://playwright.dev/python/](https://playwright.dev/python/)


# Next.js chat with Live View
URL: /integrations/ai-sdk/nextjs

---
title: Next.js chat with Live View
sidebarTitle: Next.js chat
description: Build a Next.js App Router chat app where a Vercel AI SDK v6 agent drives a Steel cloud browser, with the Steel Live View embedded next to the chat.
llm: true
---

This guide builds a Next.js chat UI on top of the v6 quickstart. The server route uses `streamText` with Steel tools; the client uses `useChat` and pulls the Steel **live view** out of the `openSession` tool's output part — specifically `session.debugUrl`, the interactive embed -- to render a live iframe of the browser next to the chat.

For a server-only agent (`ToolLoopAgent.generate`), see the [Quickstart](/integrations/ai-sdk/quickstart).

### Requirements

*   **Steel API key**

*   **Anthropic API key**

*   **Node.js 20+**

### Step 1: Create the project

```bash Terminal -wc
git clone https://github.com/steel-dev/steel-cookbook
cd steel-cookbook/examples/steel-ai-sdk-nextjs-starter
npm install
npx playwright install chromium
```

### Step 2: Environment variables

```env ENV -wcn -f .env.local
STEEL_API_KEY=your-steel-api-key-here
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```

### Step 3: API route

`streamText` drives the loop. Tools are defined **inside** the handler so each request gets its own Steel session held in a closure. `prepareStep` phase-gates tools. `onFinish`/`onAbort` release the session. `submitForm` shows off v6's `needsApproval` — the tool call streams to the UI for confirmation before executing.

```typescript Typescript -wcn -f app/api/chat/route.ts
import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { chromium, type Browser, type Page } from "playwright";
import Steel from "steel-sdk";
import { z } from "zod";

// Playwright needs the Node.js runtime (not Edge).
export const runtime = "nodejs";
export const maxDuration = 120;

const STEEL_API_KEY = process.env.STEEL_API_KEY!;

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const steel = new Steel({ steelAPIKey: STEEL_API_KEY });

  let session: Awaited<ReturnType<typeof steel.sessions.create>> | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;

  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  };

  const result = streamText({
    model: anthropic("claude-haiku-4-5"),
    system: [
      "You operate a Steel cloud browser via tools.",
      "Workflow: (1) call openSession, (2) navigate to the target URL,",
      "(3) call snapshot to see the page's text and links,",
      "(4) only call extract when you need structured rows beyond what snapshot gives,",
      "(5) reply to the user in plain English.",
      "Prefer snapshot's links list over guessing selectors. Do not invent data.",
    ].join(" "),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(15),
    tools: {
      openSession: tool({
        description:
          "Open a Steel cloud browser session. Call this exactly once, before anything else.",
        inputSchema: z.object({}),
        execute: async () => {
          session = await steel.sessions.create({});
          browser = await chromium.connectOverCDP(
            `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
          );
          const ctx = browser.contexts()[0];
          page = ctx.pages()[0] ?? (await ctx.newPage());
          return {
            sessionId: session.id,
            liveViewUrl: session.sessionViewerUrl,
            debugUrl: session.debugUrl,
          };
        },
      }),
      navigate: tool({
        description: "Navigate the open session to a URL.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          if (!page) throw new Error("openSession must be called first.");
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          return { url: page.url(), title: await page.title() };
        },
      }),
      snapshot: tool({
        description:
          "Return a readable snapshot of the current page: title, URL, visible text (capped), and a list of links with their text and href. Call this BEFORE extract so you never have to guess CSS selectors.",
        inputSchema: z.object({
          maxChars: z.number().int().positive().max(10_000).default(4_000),
          maxLinks: z.number().int().positive().max(200).default(50),
        }),
        execute: async ({ maxChars, maxLinks }) => {
          if (!page) throw new Error("openSession must be called first.");
          return (await page.evaluate(
            ({ maxChars, maxLinks }: { maxChars: number; maxLinks: number }) => {
              const text = (document.body.innerText || "").slice(0, maxChars);
              const links = Array.from(document.querySelectorAll("a[href]"))
                .slice(0, maxLinks)
                .map((a) => {
                  const anchor = a as HTMLAnchorElement;
                  const t = (anchor.innerText || anchor.textContent || "").trim().slice(0, 120);
                  return { text: t, href: anchor.href };
                })
                .filter((l) => l.text && l.href);
              return { url: location.href, title: document.title, text, links };
            },
            { maxChars, maxLinks }
          )) as { url: string; title: string; text: string; links: { text: string; href: string }[] };
        },
      }),
      extract: tool({
        description:
          "Extract structured data from the current page using CSS selectors.",
        inputSchema: z.object({
          rowSelector: z.string(),
          fields: z.array(z.object({
            name: z.string(),
            selector: z.string(),
            attr: z.string().optional(),
          })).min(1).max(10),
          limit: z.number().int().positive().max(20).default(10),
        }),
        execute: async ({ rowSelector, fields, limit }) => {
          if (!page) throw new Error("openSession must be called first.");
          // Batch the extraction inside one page.evaluate — N*M serial
          // CDP calls would cost seconds on a cloud browser.
          const items = (await page.evaluate(
            ({ rowSelector, fields, limit }: {
              rowSelector: string;
              fields: { name: string; selector: string; attr?: string }[];
              limit: number;
            }) => {
              const rows = Array.from(
                document.querySelectorAll(rowSelector)
              ).slice(0, limit);
              return rows.map((row) => {
                const item: Record<string, string> = {};
                for (const f of fields) {
                  const el = f.selector
                    ? (row.querySelector(f.selector) as Element | null)
                    : row;
                  if (!el) { item[f.name] = ""; continue; }
                  if (f.attr) {
                    item[f.name] = (el.getAttribute(f.attr) ?? "").trim();
                  } else {
                    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
                    item[f.name] = text.trim();
                  }
                }
                return item;
              });
            },
            { rowSelector, fields, limit }
          )) as Record<string, string>[];
          return { count: items.length, items };
        },
      }),
      // v6's needsApproval: destructive tools stream to the UI without executing,
      // wait for user confirmation, then resume. Wire up approval UI on the client
      // for this to run end-to-end.
      submitForm: tool({
        description: "Submit a form on the current page. Requires user approval.",
        inputSchema: z.object({
          reason: z.string().describe("Why this submission is safe."),
        }),
        needsApproval: true,
        execute: async ({ reason }) => {
          return { submitted: false, note: `Demo only. Reason: ${reason}` };
        },
      }),
    },
    // Phase-gate: no one can navigate before the session is open, and the
    // agent can't open a second session.
    prepareStep: async ({ stepNumber, steps }) => {
      const opened = steps.some((s: any) =>
        s.toolCalls?.some((tc: any) => tc.toolName === "openSession")
      );
      if (stepNumber === 0 || !opened) return { activeTools: ["openSession"] };
      return { activeTools: ["navigate", "snapshot", "extract", "submitForm"] };
    },
    onStepFinish: async ({ toolCalls, usage }) => {
      const names = toolCalls?.map((t: any) => t.toolName).join(", ") || "";
      console.log(`  step: ${names || "(text)"} | ${usage?.totalTokens ?? 0} tokens`);
    },
    onFinish: cleanup,
    onAbort: cleanup,
  });

  return result.toUIMessageStreamResponse();
}
```

### Step 4: Client page

`useChat` handles the streaming protocol. We walk `message.parts` to find the `tool-openSession` output, which contains both `debugUrl` (the interactive embed we render in the iframe) and `liveViewUrl` (the shareable viewer link).

```tsx Typescript -wcn -f app/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";
import { useMemo, useState } from "react";

export default function Page() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");

  const { debugUrl, liveViewUrl } = useMemo(() => {
    for (const m of messages) {
      for (const part of (m.parts ?? []) as any[]) {
        if (part?.type === "tool-openSession" && part?.output) {
          return {
            debugUrl: (part.output.debugUrl ?? null) as string | null,
            liveViewUrl: (part.output.liveViewUrl ?? null) as string | null,
          };
        }
      }
    }
    return { debugUrl: null, liveViewUrl: null };
  }, [messages]);

  return (
    <main style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", height: "100vh" }}>
      <section>
        {messages.map((m) => (
          <div key={m.id}>
            {(m.parts ?? []).map((part: any, i: number) => {
              if (part.type === "text") return <span key={i}>{part.text}</span>;
              if (String(part.type).startsWith("tool-")) {
                return (
                  <pre key={i}>
                    {String(part.type)} {part.state} {JSON.stringify(part.input)}
                  </pre>
                );
              }
              return null;
            })}
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            sendMessage({ text: input });
            setInput("");
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} />
          <button disabled={status !== "ready"}>Send</button>
        </form>
      </section>
      <aside>
        {liveViewUrl && (
          <a href={liveViewUrl} target="_blank" rel="noreferrer">open in new tab ↗</a>
        )}
        {debugUrl ? (
          <iframe
            src={debugUrl}
            sandbox="allow-same-origin allow-scripts"
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        ) : (
          <div>Live View appears once the agent opens a session.</div>
        )}
      </aside>
    </main>
  );
}
```

:::callout
type: tip
### `debugUrl` vs `sessionViewerUrl`
`session.debugUrl` is the **interactive** embed — it streams WebRTC video at 25 fps and, by default (`?interactive=true`), accepts mouse/keyboard input so a user can take over the session. See [Live Sessions](/overview/sessions-api/embed-sessions/live-sessions) for supported query params. `session.sessionViewerUrl` is the shareable viewer page.
:::

### Step 5: Run

```bash Terminal -wc
npm run dev
```

Open `http://localhost:3000` and ask:

> Go to https://github.com/trending/python and tell me the top 3 AI/ML repos.

The agent opens a Steel session (the Live View iframe fills in), navigates, extracts, and replies.

### Deploying to Vercel

1. Push to GitHub.
2. Import the repo on Vercel.
3. Add `STEEL_API_KEY` and `ANTHROPIC_API_KEY` as Environment Variables.
4. Set Build Command to:

```bash
npx playwright install chromium && next build
```

:::callout
type: tip
### Tool approval (needsApproval)
v6 lets destructive tools require a user approval step with `needsApproval: true`. The tool call emits to the UI without executing; you confirm, and the stream resumes. Useful for Steel sessions that post forms, make purchases, or modify remote state.
:::

### Next Steps

*   **Quickstart (ToolLoopAgent)**: [/integrations/ai-sdk/quickstart](/integrations/ai-sdk/quickstart)

*   **`useChat` reference**: [https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)

*   **Human-in-the-loop tools**: [https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

*   **Steel Sessions API**: [/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **This example on GitHub**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-ai-sdk-nextjs-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-ai-sdk-nextjs-starter)


# Quickstart
URL: /integrations/ai-sdk/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: Build a typed, tool-using browser agent with Steel and the Vercel AI SDK v6 ToolLoopAgent. The agent opens a Steel session, navigates and extracts, and ends with a typed final tool whose input is the structured result.
llm: true
---

Scroll to the bottom to see a full example!

### Requirements

*   **Steel API key**

*   **Anthropic API key**

*   **Node.js 20+**

### Step 1: Project Setup

Create a new TypeScript project and basic script:

```bash Terminal -wc
mkdir steel-ai-sdk && \
cd steel-ai-sdk && \
npm init -y && \
npm install -D typescript @types/node ts-node && \
npx tsc --init && \
npm pkg set scripts.start="ts-node index.ts" && \
touch index.ts .env
```

### Step 2: Install Dependencies

```package-install
ai @ai-sdk/anthropic steel-sdk playwright zod dotenv
```

### Step 3: Environment Variables

Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```

### Step 4: Define Steel tools

Each tool is a typed `tool()` with a Zod input schema. Browser state (the Steel session + Playwright page) lives in a closure so every tool call sees the same page.

```typescript Typescript -wcn -f index.ts
import * as dotenv from "dotenv";
import Steel from "steel-sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, tool, stepCountIs, hasToolCall } from "ai";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";

dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "your-anthropic-api-key-here";

const steel = new Steel({ steelAPIKey: STEEL_API_KEY });

let session: Awaited<ReturnType<typeof steel.sessions.create>> | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

const openSession = tool({
  description:
    "Open a Steel cloud browser session. Call this exactly once, before anything else.",
  inputSchema: z.object({}),
  execute: async () => {
    session = await steel.sessions.create({});
    browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
    );
    const ctx = browser.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.newPage());
    return { sessionId: session.id, liveViewUrl: session.sessionViewerUrl };
  },
});

const navigate = tool({
  description:
    "Navigate the open session to a URL and wait for the page to load.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    if (!page) throw new Error("openSession must be called first.");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return { url: page.url(), title: await page.title() };
  },
});

const snapshot = tool({
  description:
    "Return a readable snapshot of the current page: title, URL, visible text (capped), and a list of links with their text and href. Call this BEFORE extract so you never have to guess CSS selectors.",
  inputSchema: z.object({
    maxChars: z.number().int().positive().max(10_000).default(4_000),
    maxLinks: z.number().int().positive().max(200).default(50),
  }),
  execute: async ({ maxChars, maxLinks }) => {
    if (!page) throw new Error("openSession must be called first.");
    return (await page.evaluate(
      ({ maxChars, maxLinks }: { maxChars: number; maxLinks: number }) => {
        const text = (document.body.innerText || "").slice(0, maxChars);
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, maxLinks)
          .map((a) => {
            const anchor = a as HTMLAnchorElement;
            const t = (anchor.innerText || anchor.textContent || "").trim().slice(0, 120);
            return { text: t, href: anchor.href };
          })
          .filter((l) => l.text && l.href);
        return { url: location.href, title: document.title, text, links };
      },
      { maxChars, maxLinks }
    )) as { url: string; title: string; text: string; links: { text: string; href: string }[] };
  },
});

const extract = tool({
  description:
    "Extract structured data from the current page using CSS selectors. Provide one row selector plus a list of per-row field selectors.",
  inputSchema: z.object({
    rowSelector: z
      .string()
      .describe("CSS selector matching each item. e.g. 'article.Box-row'"),
    fields: z.array(z.object({
      name: z.string(),
      selector: z
        .string()
        .describe(
          "CSS selector relative to the row. Use an empty string to read the row element itself."
        ),
      attr: z
        .string()
        .optional()
        .describe("Optional attribute to read instead of innerText, e.g. 'href'."),
    })).min(1).max(10),
    limit: z.number().int().positive().max(20).default(10),
  }),
  execute: async ({ rowSelector, fields, limit }) => {
    if (!page) throw new Error("openSession must be called first.");
    // Run the whole extraction inside one page.evaluate so we pay the
    // CDP round-trip once, not N*M times. Serial CDP calls (row.$,
    // el.getAttribute, el.innerText) are the single biggest source of
    // slowness on a cloud browser.
    const items = (await page.evaluate(
      ({ rowSelector, fields, limit }: {
        rowSelector: string;
        fields: { name: string; selector: string; attr?: string }[];
        limit: number;
      }) => {
        const rows = Array.from(
          document.querySelectorAll(rowSelector)
        ).slice(0, limit);
        return rows.map((row) => {
          const item: Record<string, string> = {};
          for (const f of fields) {
            const el = f.selector
              ? (row.querySelector(f.selector) as Element | null)
              : row;
            if (!el) { item[f.name] = ""; continue; }
            if (f.attr) {
              item[f.name] = (el.getAttribute(f.attr) ?? "").trim();
            } else {
              const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
              item[f.name] = text.trim();
            }
          }
          return item;
        });
      },
      { rowSelector, fields, limit }
    )) as Record<string, string>[];
    return { count: items.length, items };
  },
});
```

:::callout
type: warn
### Don't do N×M serial CDP calls
The obvious implementation — `page.$$(rowSelector)` then `await row.$(f.selector)` and `await el.innerText()` per field — looks fine locally but each of those awaits is a separate CDP round-trip to Steel's cloud browser (~200-300ms each). A 10×4 extract becomes 40 round-trips (8-12 seconds). The `page.evaluate` version above is one round-trip: &lt;500ms.
:::

### Step 5: Build the ToolLoopAgent

The agent's last move is a **`reportFindings` tool** with a Zod-typed input and **no `execute`**. In v6, a tool without an `execute` stops the loop as soon as it's called — so this tool doubles as the structured-output carrier. The typed final result is the tool call's `input`.

:::callout
type: tip
Why not `output: Output.object(...)`? On Anthropic, forcing a JSON response format disables tool calling — the provider warns `"JSON response format does not support tools. The provided tools are ignored."` The "final tool" pattern is the v6-idiomatic way to combine tool loops with typed output.
:::

```typescript Typescript -wcn -f index.ts
const reportFindings = tool({
  description:
    "Call this LAST with your final findings. Calling this ends the research.",
  inputSchema: z.object({
    summary: z
      .string()
      .describe("One-paragraph summary of what these repos have in common."),
    repos: z.array(z.object({
      name: z.string(),
      url: z.string(),
      stars: z.string().optional(),
      description: z.string().optional(),
    })).min(1).max(5),
  }),
  // intentionally no execute: lacking execute makes v6 stop the loop
});

const researchAgent = new ToolLoopAgent({
  model: anthropic("claude-haiku-4-5"),
  instructions: [
    "You operate a Steel cloud browser via tools.",
    "Workflow: (1) call openSession, (2) navigate to the target URL,",
    "(3) call snapshot to see the page's text and links,",
    "(4) only call extract when you need structured rows beyond what snapshot gives you,",
    "(5) call reportFindings once with your final result.",
    "Do not invent data. Prefer snapshot's links list over guessing selectors.",
  ].join(" "),
  stopWhen: [stepCountIs(15), hasToolCall("reportFindings")],
  tools: { openSession, navigate, snapshot, extract, reportFindings },
  onStepFinish: async ({ stepNumber, toolCalls, usage }) => {
    const names = toolCalls?.map((t: any) => t.toolName).join(", ") || "(text only)";
    console.log(`  step ${stepNumber}: ${names} | ${usage?.totalTokens ?? 0} tokens`);
  },
});
```

:::callout
type: tip
### Why add `snapshot` at all?
Without it, the agent has to guess CSS selectors. Wrong guess → empty extract → retry → another model round-trip. `snapshot` returns the page's visible text + link list in one `page.evaluate` (&lt;500ms), so the agent can decide whether `extract` is even necessary. For link-heavy sites (trending pages, news indexes, search results) the findings are already in the `links` list, and the agent skips `extract` entirely — saving a step.
:::

### Step 6: Run the agent and clean up

The agent opens the Steel session itself during its first step. The final typed result is the `reportFindings` tool call's `input`, found in `result.steps`.

```typescript Typescript -wcn -f index.ts
async function main() {
  try {
    const result = await researchAgent.generate({
      prompt:
        "Go to https://github.com/trending/python?since=daily and return the top 3 AI/ML-related repositories. For each, give its full name (owner/repo), GitHub URL, star count as shown on the page, and the repo description.",
    });

    const steps = (result as any).steps ?? [];
    const reportCall = steps
      .flatMap((s: any) => s.toolCalls ?? [])
      .find((tc: any) => tc.toolName === "reportFindings");
    const structured = reportCall?.input ?? { text: result.text };

    console.log(JSON.stringify(structured, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

#### Run It

```bash Terminal -wc
npm start
```

You'll see a live **session viewer URL** in the console — open it to watch the agent drive the browser in real time.

### Phase-gate tools with prepareStep (optional)

`prepareStep` runs before each step and can narrow the tool set per phase — preventing the agent from calling `openSession` twice, or from extracting before navigating.

```typescript
prepareStep: async ({ stepNumber, steps }) => {
  if (stepNumber === 0) return { activeTools: ["openSession"] };
  return { activeTools: ["navigate", "extract"] };
},
```

### Swap the model

The default is Claude Haiku 4.5 — fast and cheap, which matters because the agent round-trips through the model 3-5 times per run. Swap up when the task needs stronger reasoning:

```typescript
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

// model: anthropic("claude-sonnet-4-6"), // smarter, slower
// model: openai("gpt-5"),
// model: google("gemini-2.5-pro"),
```

Or use the [AI Gateway](https://vercel.com/docs/ai-gateway) string form (e.g. `"anthropic/claude-haiku-4-5"`) to route through Vercel.

### Full Example

Complete `index.ts` you can paste and run:

```typescript Typescript -wcn -f index.ts
/*
 * Build an AI browser agent with Vercel AI SDK v6 (ToolLoopAgent) and Steel.
 * https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-ai-sdk-starter
 */

import * as dotenv from "dotenv";
import Steel from "steel-sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, tool, stepCountIs, hasToolCall } from "ai";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";

dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "your-anthropic-api-key-here";

const steel = new Steel({ steelAPIKey: STEEL_API_KEY });

let session: Awaited<ReturnType<typeof steel.sessions.create>> | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

const openSession = tool({
  description:
    "Open a Steel cloud browser session. Call this exactly once, before anything else.",
  inputSchema: z.object({}),
  execute: async () => {
    session = await steel.sessions.create({});
    browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
    );
    const ctx = browser.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.newPage());
    return { sessionId: session.id, liveViewUrl: session.sessionViewerUrl };
  },
});

const navigate = tool({
  description:
    "Navigate the open session to a URL and wait for the page to load.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    if (!page) throw new Error("openSession must be called first.");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return { url: page.url(), title: await page.title() };
  },
});

const snapshot = tool({
  description:
    "Return a readable snapshot of the current page: title, URL, visible text (capped), and a list of links with their text and href. Call this BEFORE extract so you never have to guess CSS selectors.",
  inputSchema: z.object({
    maxChars: z.number().int().positive().max(10_000).default(4_000),
    maxLinks: z.number().int().positive().max(200).default(50),
  }),
  execute: async ({ maxChars, maxLinks }) => {
    if (!page) throw new Error("openSession must be called first.");
    return (await page.evaluate(
      ({ maxChars, maxLinks }: { maxChars: number; maxLinks: number }) => {
        const text = (document.body.innerText || "").slice(0, maxChars);
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, maxLinks)
          .map((a) => {
            const anchor = a as HTMLAnchorElement;
            const t = (anchor.innerText || anchor.textContent || "").trim().slice(0, 120);
            return { text: t, href: anchor.href };
          })
          .filter((l) => l.text && l.href);
        return { url: location.href, title: document.title, text, links };
      },
      { maxChars, maxLinks }
    )) as { url: string; title: string; text: string; links: { text: string; href: string }[] };
  },
});

const extract = tool({
  description:
    "Extract structured data from the current page using CSS selectors. Provide one row selector plus a list of per-row field selectors.",
  inputSchema: z.object({
    rowSelector: z
      .string()
      .describe("CSS selector matching each item. e.g. 'article.Box-row'"),
    fields: z.array(z.object({
      name: z.string(),
      selector: z
        .string()
        .describe(
          "CSS selector relative to the row. Use an empty string to read the row element itself."
        ),
      attr: z
        .string()
        .optional()
        .describe("Optional attribute to read instead of innerText, e.g. 'href'."),
    })).min(1).max(10),
    limit: z.number().int().positive().max(20).default(10),
  }),
  execute: async ({ rowSelector, fields, limit }) => {
    if (!page) throw new Error("openSession must be called first.");
    const items = (await page.evaluate(
      ({ rowSelector, fields, limit }: {
        rowSelector: string;
        fields: { name: string; selector: string; attr?: string }[];
        limit: number;
      }) => {
        const rows = Array.from(
          document.querySelectorAll(rowSelector)
        ).slice(0, limit);
        return rows.map((row) => {
          const item: Record<string, string> = {};
          for (const f of fields) {
            const el = f.selector
              ? (row.querySelector(f.selector) as Element | null)
              : row;
            if (!el) { item[f.name] = ""; continue; }
            if (f.attr) {
              item[f.name] = (el.getAttribute(f.attr) ?? "").trim();
            } else {
              const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
              item[f.name] = text.trim();
            }
          }
          return item;
        });
      },
      { rowSelector, fields, limit }
    )) as Record<string, string>[];
    return { count: items.length, items };
  },
});

const reportFindings = tool({
  description:
    "Call this LAST with your final findings. Calling this ends the research.",
  inputSchema: z.object({
    summary: z
      .string()
      .describe("One-paragraph summary of what these repos have in common."),
    repos: z.array(z.object({
      name: z.string(),
      url: z.string(),
      stars: z.string().optional(),
      description: z.string().optional(),
    })).min(1).max(5),
  }),
  // intentionally no execute: lacking execute makes v6 stop the loop
});

const researchAgent = new ToolLoopAgent({
  model: anthropic("claude-haiku-4-5"),
  instructions: [
    "You operate a Steel cloud browser via tools.",
    "Workflow: (1) call openSession, (2) navigate to the target URL,",
    "(3) call snapshot to see the page's text and links,",
    "(4) only call extract when you need structured rows beyond what snapshot gives you,",
    "(5) call reportFindings once with your final result.",
    "Do not invent data. Prefer snapshot's links list over guessing selectors.",
  ].join(" "),
  stopWhen: [stepCountIs(15), hasToolCall("reportFindings")],
  tools: { openSession, navigate, snapshot, extract, reportFindings },
  onStepFinish: async ({ stepNumber, toolCalls, usage }) => {
    const names = toolCalls?.map((t: any) => t.toolName).join(", ") || "(text only)";
    console.log(`  step ${stepNumber}: ${names} | ${usage?.totalTokens ?? 0} tokens`);
  },
});

async function main() {
  try {
    const result = await researchAgent.generate({
      prompt:
        "Go to https://github.com/trending/python?since=daily and return the top 3 AI/ML-related repositories. For each, give its full name (owner/repo), GitHub URL, star count as shown on the page, and the repo description.",
    });

    const steps = (result as any).steps ?? [];
    const reportCall = steps
      .flatMap((s: any) => s.toolCalls ?? [])
      .find((tc: any) => tc.toolName === "reportFindings");
    const structured = reportCall?.input ?? { text: result.text };

    console.log(JSON.stringify(structured, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

### Next Steps

*   **Vercel AI SDK — Agents**: [https://ai-sdk.dev/docs/agents/overview](https://ai-sdk.dev/docs/agents/overview)

*   **ToolLoopAgent reference**: [https://ai-sdk.dev/docs/agents/building-agents](https://ai-sdk.dev/docs/agents/building-agents)

*   **Loop control (`stopWhen`, `prepareStep`)**: [https://ai-sdk.dev/docs/agents/loop-control](https://ai-sdk.dev/docs/agents/loop-control)

*   **Steel Sessions API**: [/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **Steel Node SDK**: [https://github.com/steel-dev/steel-node](https://github.com/steel-dev/steel-node)

*   **This Example on GitHub**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-ai-sdk-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-ai-sdk-starter)


# Captcha Solving
URL: /integrations/browser-use/captcha-solving

---
title: Captcha Solving
sidebarTitle: Captcha Solving
description: A step-by-step guide to connecting Steel with Browser-use and solving captchas.
llm: true
---

This guide walks you through connecting a Steel cloud browser session with the browser-use framework, enabling an AI agent to interact with websites.

#### Prerequisites

Ensure you have the following:

*   Python 3.11 or higher

*   Steel API key (sign up at [app.steel.dev](https://app.steel.dev/))

*   OpenAI API key (sign up at [platform.openai.com](https://platform.openai.com/))


#### Step 1: Set up your environment

First, create a project directory, set up a virtual environment, and install the required packages:

```bash Terminal -wc
# Create a project directory
mkdir steel-browser-use-agent
cd steel-browser-use-agent

# Recommended: Create and activate a virtual environment
uv venv
source .venv/bin/activate  # On Windows, use: .venv\Scripts\activate

# Install required packages
pip install steel-sdk browser-use python-dotenv
```

Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
TASK=Go to Wikipedia and search for machine learning
```

#### Step 2: Create a Steel browser session and initialize Tools and Session Cache

Use the Steel SDK to start a new browser session for your agent:

```python Python -wcn -f main.py
import os
from steel import Steel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"

# Validate API key
if STEEL_API_KEY == "your-steel-api-key-here":
    print("⚠️  WARNING: Please replace with your actual Steel API key")
    print("   Get your API key at: https://app.steel.dev/settings/api-keys")
    return

# Create a Steel browser session and initialize Tools and Session Cache
tools = Tools()

client = Steel(steel_api_key=STEEL_API_KEY)

SESSION_CACHE: Dict[str, Any] = {}

session = client.sessions.create()

print("✅ Steel browser session started!")
print(f"View live session at: {session.session_viewer_url}")
```


This creates a new browser session in Steel's cloud. The session\_viewer\_url allows you to watch your agent's actions in real-time.

#### Step 3: Define the Captcha Solving tools available to the Agent

```python Python -wcn -f main.py
def _has_active_captcha(states: List[Dict[str, Any]]) -> bool:
    for state in states:
        if bool(state.get("isSolvingCaptcha")):
            return True
    return False


def _summarize_states(states: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "pages": [],
        "active_pages": 0,
        "total_tasks": 0,
        "solving_tasks": 0,
        "solved_tasks": 0,
        "failed_tasks": 0,
    }

    for state in states:
        tasks = state.get("tasks", []) or []
        solving = sum(1 for t in tasks if t.get("status") == "solving")
        solved = sum(1 for t in tasks if t.get("status") == "solved")
        failed = sum(
            1
            for t in tasks
            if t.get("status") in ("failed_to_detect", "failed_to_solve")
        )

        summary["pages"].append(
            {
                "pageId": state.get("pageId"),
                "url": state.get("url"),
                "isSolvingCaptcha": bool(state.get("isSolvingCaptcha")),
                "taskCounts": {
                    "total": len(tasks),
                    "solving": solving,
                    "solved": solved,
                    "failed": failed,
                },
            }
        )
        summary["active_pages"] += 1 if bool(state.get("isSolvingCaptcha")) else 0
        summary["total_tasks"] += len(tasks)
        summary["solving_tasks"] += solving
        summary["solved_tasks"] += solved
        summary["failed_tasks"] += failed

    return summary


@tools.action(
    description=(
        "You need to invoke this tool when you encounter a CAPTCHA. It will get a human to solve the CAPTCHA and wait until the CAPTCHA is solved."
    )
)
def wait_for_captcha_solution() -> Dict[str, Any]:
    session_id = SESSION_CACHE.get("session_id")
    timeout_ms = 60000
    poll_interval_ms = 1000

    start = time.monotonic()
    end_deadline = start + (timeout_ms / 1000.0)
    last_states: List[Dict[str, Any]] = []

    while True:
        now = time.monotonic()
        if now > end_deadline:
            duration_ms = int((now - start) * 1000)
            return {
                "success": False,
                "message": "Timeout waiting for CAPTCHAs to be solved",
                "duration_ms": duration_ms,
                "last_status": _summarize_states(last_states) if last_states else {},
            }
        try:
            # Convert CapchaStatusResponseItems to dict
            last_states = [
                state.to_dict() for state in client.sessions.captchas.status(session_id)
            ]

        except Exception:
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": False,
                    "message": "Failed to get CAPTCHA status; please try again",
                    "duration_ms": duration_ms,
                    "last_status": {},
                }
            )
            return "Failed to get CAPTCHA status; please try again"

        if not last_states:
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": True,
                    "message": "No active CAPTCHAs",
                    "duration_ms": duration_ms,
                    "last_status": {},
                }
            )
            return "No active CAPTCHAs"

        if not _has_active_captcha(last_states):
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": True,
                    "message": "All CAPTCHAs solved",
                    "duration_ms": duration_ms,
                    "last_status": _summarize_states(last_states),
                }
            )
            return "All CAPTCHAs solved"

        time.sleep(poll_interval_ms / 1000.0)
```

#### Step 4: Define Your Browser Session

Connect the browser-use BrowserSession class to your Steel session using the CDP URL:

```python Python -wcn -f main.py
from browser_use import Agent, BrowserSession

# Connect browser-use to the Steel session
cdp_url = f"wss://connect.steel.dev?apiKey={STEEL_API_KEY}&sessionId={session.id}"
browser_session = BrowserSession(cdp_url=cdp_url)
```


#### Step 5: Define your AI Agent

Here we bring it all together by defining our agent with what browser, browser context, task, and LLM to use.

```python Python -wcn -f main.py
# After setting up the browser session
from browser_use import Agent
from browser_use.llm import ChatOpenAI

# Create a ChatOpenAI model for agent reasoning
model = ChatOpenAI(
    model="gpt-5",
    api_key=os.getenv('OPENAI_API_KEY')
)

# Define the task for the agent
task = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"

# Create the agent with the task, model, browser session, and tools
agent = Agent(
    task=task,
    llm=model,
    browser_session=browser_session,
    tools=tools,
)
```


This configures the AI agent with:

*   An OpenAI model for reasoning

*   The browser session instance from Step 3

*   A specific task to perform


**Models:**
This example uses **GPT-5**, but you can use any browser-use compatible models like Anthropic, DeepSeek, or Gemini. See the full list of supported models here.

#### Step 6: Run your Agent

```python Python -wcn -f main.py
import time

# Define the main function with the agent execution
async def main():
    try:
        start_time = time.time()

        print(f"🎯 Executing task: {task}")
        print("=" * 60)

        # Run the agent
        result = await agent.run()

        duration = f"{(time.time() - start_time):.1f}"

        print("\n" + "=" * 60)
        print("🎉 TASK EXECUTION COMPLETED")
        print("=" * 60)
        print(f"⏱️  Duration: {duration} seconds")
        print(f"🎯 Task: {task}")
        if result:
            print(f"📋 Result:\n{result}")
        print("=" * 60)

    except Exception as e:
        print(f"❌ Task execution failed: {e}")
    finally:
        # Clean up resources
        if session:
            print("Releasing Steel session...")
            client.sessions.release(session.id)
            print(f"Session completed. View replay at {session.session_viewer_url}")
        print("Done!")

# Run the async main function
if __name__ == '__main__':
    asyncio.run(main())
```


The agent will spin up a steel browser session and interact with it to complete the task. After completion, it's important to properly close the browser and release the Steel session.

#### Complete example

Here's the complete script that puts all steps together:

```python Python -wcn -f main.py
"""
AI-powered browser automation using browser-use library with Steel browsers.
https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-browser-use-starter
"""

import os
import time
import asyncio
from dotenv import load_dotenv
from steel import Steel
from browser_use import Agent, BrowserSession
from browser_use.llm import ChatOpenAI

load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"

# Replace with your own task
TASK = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"

tools = Tools()

client = Steel(steel_api_key=STEEL_API_KEY)

SESSION_CACHE: Dict[str, Any] = {}

def _has_active_captcha(states: List[Dict[str, Any]]) -> bool:
    for state in states:
        if bool(state.get("isSolvingCaptcha")):
            return True
    return False


def _summarize_states(states: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "pages": [],
        "active_pages": 0,
        "total_tasks": 0,
        "solving_tasks": 0,
        "solved_tasks": 0,
        "failed_tasks": 0,
    }

    for state in states:
        tasks = state.get("tasks", []) or []
        solving = sum(1 for t in tasks if t.get("status") == "solving")
        solved = sum(1 for t in tasks if t.get("status") == "solved")
        failed = sum(
            1
            for t in tasks
            if t.get("status") in ("failed_to_detect", "failed_to_solve")
        )

        summary["pages"].append(
            {
                "pageId": state.get("pageId"),
                "url": state.get("url"),
                "isSolvingCaptcha": bool(state.get("isSolvingCaptcha")),
                "taskCounts": {
                    "total": len(tasks),
                    "solving": solving,
                    "solved": solved,
                    "failed": failed,
                },
            }
        )
        summary["active_pages"] += 1 if bool(state.get("isSolvingCaptcha")) else 0
        summary["total_tasks"] += len(tasks)
        summary["solving_tasks"] += solving
        summary["solved_tasks"] += solved
        summary["failed_tasks"] += failed

    return summary


@tools.action(
    description=(
        "You need to invoke this tool when you encounter a CAPTCHA. It will get a human to solve the CAPTCHA and wait until the CAPTCHA is solved."
    )
)
def wait_for_captcha_solution() -> Dict[str, Any]:
    session_id = SESSION_CACHE.get("session_id")
    timeout_ms = 60000
    poll_interval_ms = 1000

    start = time.monotonic()
    end_deadline = start + (timeout_ms / 1000.0)
    last_states: List[Dict[str, Any]] = []

    while True:
        now = time.monotonic()
        if now > end_deadline:
            duration_ms = int((now - start) * 1000)
            return {
                "success": False,
                "message": "Timeout waiting for CAPTCHAs to be solved",
                "duration_ms": duration_ms,
                "last_status": _summarize_states(last_states) if last_states else {},
            }
        try:
            # Convert CapchaStatusResponseItems to dict
            last_states = [
                state.to_dict() for state in client.sessions.captchas.status(session_id)
            ]

        except Exception:
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": False,
                    "message": "Failed to get CAPTCHA status; please try again",
                    "duration_ms": duration_ms,
                    "last_status": {},
                }
            )
            return "Failed to get CAPTCHA status; please try again"

        if not last_states:
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": True,
                    "message": "No active CAPTCHAs",
                    "duration_ms": duration_ms,
                    "last_status": {},
                }
            )
            return "No active CAPTCHAs"

        if not _has_active_captcha(last_states):
            duration_ms = int((time.monotonic() - start) * 1000)
            print(
                {
                    "success": True,
                    "message": "All CAPTCHAs solved",
                    "duration_ms": duration_ms,
                    "last_status": _summarize_states(last_states),
                }
            )
            return "All CAPTCHAs solved"

        time.sleep(poll_interval_ms / 1000.0)



async def main():
    print("🚀 Steel + Browser Use Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    if OPENAI_API_KEY == "your-openai-api-key-here":
        print("⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key")
        print("   Get your API key at: https://platform.openai.com/api-keys")
        return

    print("\nStarting Steel browser session...")

    try:
        session = client.sessions.create()
        print("✅ Steel browser session started!")
        print(f"View live session at: {session.session_viewer_url}")

        print(
            f"\033[1;93mSteel Session created!\033[0m\n"
            f"View session at \033[1;37m{session.session_viewer_url}\033[0m\n"
        )

        cdp_url = f"wss://connect.steel.dev?apiKey={STEEL_API_KEY}&sessionId={session.id}"

        model = ChatOpenAI(model="gpt-5", api_key=OPENAI_API_KEY)
        agent = Agent(task=TASK, llm=model, browser_session=BrowserSession(cdp_url=cdp_url), tools=tools)

        start_time = time.time()

        print(f"🎯 Executing task: {TASK}")
        print("=" * 60)

        try:
            result = await agent.run()

            duration = f"{(time.time() - start_time):.1f}"

            print("\n" + "=" * 60)
            print("🎉 TASK EXECUTION COMPLETED")
            print("=" * 60)
            print(f"⏱️  Duration: {duration} seconds")
            print(f"🎯 Task: {TASK}")
            if result:
                print(f"📋 Result:\n{result}")
            print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
        finally:
            if session:
                print("Releasing Steel session...")
                client.sessions.release(session.id)
                print(f"Session completed. View replay at {session.session_viewer_url}")
            print("Done!")

    except Exception as e:
        print(f"❌ Failed to start Steel browser: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")


if __name__ == "__main__":
    asyncio.run(main())
```


Save this as main.py and run it with:

#### Customizing your agent's task

Try modifying the task to make your agent perform different actions:

```python Python -wcn -f main.py
TASK="""
1. Go to https://recaptcha-demo.appspot.com/recaptcha-v2-checkbox.php
2. If you see a CAPTCHA box, use the wait_for_captcha_solution tool to solve it
3. Once the CAPTCHA is solved, submit the form
4. Return the result
"""
```


Congratulations! You've successfully connected a Steel browser session with browser-use to solve a CAPTCHA.


# Overview
URL: /integrations/browser-use/integrations-overview

---
title: Overview
sidebarTitle: Overview
description: Browser-Use is an open-source library that enables AI agents to control and interact with browsers programmatically. This integration connects Browser-Use with Steel's infrastructure, allowing for seamless automation of web tasks and workflows.
llm: true
---
### Overview

The Browser-Use integration connects Steel's browser infrastructure with the Browser-Use agent framework, enabling AI models to perform complex web interactions. Agents can navigate websites, fill forms, click buttons, extract data, and complete multi-step tasks - all while leveraging Steel's reliable cloud-based browsers for execution. This integration bridges the gap between AI capabilities and real-world web applications without requiring custom API development.

### Requirements & Limitations

*   **Python Version**: Requires Python 3.11 or higher

*   **Dependencies**: Ships with its own LLM wrappers via `browser_use.llm` — no LangChain required

*   **Supported Models**: Works best with vision-capable models (GPT-5, Claude Sonnet 4, Gemini 3 Pro)

*   **Limitations**: Performance depends on the underlying LLM's ability to understand visual context


### Documentation

[Quickstart Guide](/integrations/browser-use/quickstart) → Quickstart step-by-step guide how to install browser-use, configure your environment, and create your first agent to interact with websites through Steel.

### Additional Resources

*   [Example Repository](https://github.com/browser-use/browser-use/tree/main/examples) - Working example implementations for various use cases

*   [Discord Community](https://link.browser-use.com/discord) - Join discussions and get support

*   [Browser-Use Documentation](https://docs.browser-use.com/) - Comprehensive guide to the browser-use library


# Quickstart
URL: /integrations/browser-use/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: A step-by-step guide to connecting Steel with Browser-use.
llm: true
---

This guide walks you through connecting a Steel cloud browser session with the browser-use framework, enabling an AI agent to interact with websites.

#### Prerequisites

Ensure you have the following:

*   Python 3.11 or higher

*   Steel API key (sign up at [app.steel.dev](https://app.steel.dev/))

*   OpenAI API key (sign up at [platform.openai.com](https://platform.openai.com/))


#### Step 1: Set up your environment

First, set up a virtual environment, and install the required packages:

```package-install python
steel-sdk browser-use python-dotenv
```

Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
TASK=Go to Wikipedia and search for machine learning
```


#### Step 2: Create a Steel browser session

Use the Steel SDK to start a new browser session for your agent:

```python Python -wcn -f main.py
import os
from steel import Steel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"

# Validate API key
if STEEL_API_KEY == "your-steel-api-key-here":
    print("⚠️  WARNING: Please replace with your actual Steel API key")
    print("   Get your API key at: https://app.steel.dev/settings/api-keys")
    return

# Create a Steel browser session
client = Steel(steel_api_key=STEEL_API_KEY)
session = client.sessions.create()

print("✅ Steel browser session started!")
print(f"View live session at: {session.session_viewer_url}")
```


This creates a new browser session in Steel's cloud. The session\_viewer\_url allows you to watch your agent's actions in real-time.

#### Step 3: Define Your Browser Session

Connect the browser-use BrowserSession class to your Steel session using the CDP URL:

```python Python -wcn -f main.py
from browser_use import Agent, BrowserSession

# Connect browser-use to the Steel session
cdp_url = f"wss://connect.steel.dev?apiKey={STEEL_API_KEY}&sessionId={session.id}"
browser_session = BrowserSession(cdp_url=cdp_url)
```


#### Step 4: Define your AI Agent

Here we bring it all together by defining our agent with what browser, browser context, task, and LLM to use.

```python Python -wcn -f main.py
# After setting up the browser session
from browser_use import Agent
from browser_use.llm import ChatOpenAI

# Create a ChatOpenAI model for agent reasoning
model = ChatOpenAI(
    model="gpt-5",
    api_key=os.getenv('OPENAI_API_KEY')
)

# Define the task for the agent
task = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"

# Create the agent with the task, model, and browser session
agent = Agent(
    task=task,
    llm=model,
    browser_session=browser_session,
)
```


This configures the AI agent with:

*   An OpenAI model for reasoning

*   The browser session instance from Step 3

*   A specific task to perform


**Models:**
This example uses **GPT-5**, but you can use any browser-use compatible models like Anthropic, DeepSeek, or Gemini. See the full list of supported models here.

#### Step 5: Run your Agent

```python Python -wcn -f main.py
import time

# Define the main function with the agent execution
async def main():
    try:
        start_time = time.time()

        print(f"🎯 Executing task: {task}")
        print("=" * 60)

        # Run the agent
        result = await agent.run()

        duration = f"{(time.time() - start_time):.1f}"

        print("\n" + "=" * 60)
        print("🎉 TASK EXECUTION COMPLETED")
        print("=" * 60)
        print(f"⏱️  Duration: {duration} seconds")
        print(f"🎯 Task: {task}")
        if result:
            print(f"📋 Result:\n{result}")
        print("=" * 60)

    except Exception as e:
        print(f"❌ Task execution failed: {e}")
    finally:
        # Clean up resources
        if session:
            print("Releasing Steel session...")
            client.sessions.release(session.id)
            print(f"Session completed. View replay at {session.session_viewer_url}")
        print("Done!")

# Run the async main function
if __name__ == '__main__':
    asyncio.run(main())
```


The agent will spin up a steel browser session and interact with it to complete the task. After completion, it's important to properly close the browser and release the Steel session.

#### Complete example

Here's the complete script that puts all steps together:

```python Python -wcn -f main.py
"""
AI-powered browser automation using browser-use library with Steel browsers.
https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-browser-use-starter
"""

import os
import time
import asyncio
from dotenv import load_dotenv
from steel import Steel
from browser_use import Agent, BrowserSession
from browser_use.llm import ChatOpenAI

load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"

# Replace with your own task
TASK = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"


async def main():
    print("🚀 Steel + Browser Use Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    if OPENAI_API_KEY == "your-openai-api-key-here":
        print("⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key")
        print("   Get your API key at: https://platform.openai.com/api-keys")
        return

    print("\nStarting Steel browser session...")

    client = Steel(steel_api_key=STEEL_API_KEY)

    try:
        session = client.sessions.create()
        print("✅ Steel browser session started!")
        print(f"View live session at: {session.session_viewer_url}")

        print(
            f"\033[1;93mSteel Session created!\033[0m\n"
            f"View session at \033[1;37m{session.session_viewer_url}\033[0m\n"
        )

        cdp_url = f"wss://connect.steel.dev?apiKey={STEEL_API_KEY}&sessionId={session.id}"

        model = ChatOpenAI(model="gpt-5", api_key=OPENAI_API_KEY)
        agent = Agent(task=TASK, llm=model, browser_session=BrowserSession(cdp_url=cdp_url))

        start_time = time.time()

        print(f"🎯 Executing task: {TASK}")
        print("=" * 60)

        try:
            result = await agent.run()

            duration = f"{(time.time() - start_time):.1f}"

            print("\n" + "=" * 60)
            print("🎉 TASK EXECUTION COMPLETED")
            print("=" * 60)
            print(f"⏱️  Duration: {duration} seconds")
            print(f"🎯 Task: {TASK}")
            if result:
                print(f"📋 Result:\n{result}")
            print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
        finally:
            if session:
                print("Releasing Steel session...")
                client.sessions.release(session.id)
                print(f"Session completed. View replay at {session.session_viewer_url}")
            print("Done!")

    except Exception as e:
        print(f"❌ Failed to start Steel browser: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")


if __name__ == "__main__":
    asyncio.run(main())
```


Save this as main.py and run it with:

#### Customizing your agent's task

Try modifying the task to make your agent perform different actions:

```env ENV -wcn -f .env
# Search for weather information
TASK = "Go to https://weather.com, search for 'San Francisco', and tell me today's forecast."

# Research product information
TASK = "Go to https://www.amazon.com, search for 'wireless headphones', and summarize the features of the first product."

# Visit a documentation site
TASK = "Go to https://docs.steel.dev, find information about the Steel API, and summarize the key features."
```


Congratulations! You've successfully connected a Steel browser session with browser-use to automate a task with AI.


# Overview
URL: /integrations/claude-computer-use/integrations-overview

---
title: Overview
sidebarTitle: Overview
description: Claude Computer Use employs vision-based AI to control browsers by continuously analyzing visual feedback, making decisions, and taking actions in a dynamic loop until the task is completed or a certain threshold is reached.
llm: true
---
#### Overview

The Claude Computer Use integration connects Claude Opus 4.7 and other Claude 4 models with Steel's browser infrastructure. This integration enables AI agents to:

*   Control Steel browser sessions via Claude's Computer Use API

*   Execute browser actions like clicking, typing, and scrolling

*   Automate complex web tasks and multi-step workflows

*   Process visual feedback from screenshots

*   Implement human verification for sensitive operations


Combining Claude's Computer Use with Steel gives you reliable automation with anti-bot capabilities, proxy support, and sandboxed environments.

#### Requirements & Limitations

*   **Anthropic API Key**: Access to Claude Opus 4.7, Opus 4.6, Sonnet 4.6, or other supported Claude 4 models

*   **Steel API Key**: Active subscription to Steel

*   **Python or Node.js Environment**: Support for API clients for both services

*   **Supported Environments**: Works best with Steel's browser environment

*   **Beta Status**: Computer Use is currently in beta with some limitations


#### Documentation

[Quickstart Guide (Python)](/integrations/claude-computer-use/quickstart-py) → Step-by-step guide to building Claude Computer Use agents with Steel sessions in Python.

[Quickstart Guide (Node.js)](/integrations/claude-computer-use/quickstart-ts) → Step-by-step guide to building Claude Computer Use agents with Steel sessions in TypeScript & Node.js.

#### Additional Resources

[Anthropic Computer Use Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) - Official documentation from Anthropic

[Steel Sessions API Reference](/api-reference) - Technical details for managing Steel browser sessions

[Cookbook Recipe (Python)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-claude-computer-use-python-starter) - Working, forkable examples of the integration in Python

[Cookbook Recipe (Node.js)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-claude-computer-use-node-starter) - Working, forkable examples of the integration in Node.js

[Community Discord](https://discord.gg/steel-dev) - Get help and share your implementations


# Quickstart (Python)
URL: /integrations/claude-computer-use/quickstart-py

---
title: Quickstart (Python)
sidebarTitle: Quickstart (Python)
description: How to use Claude Computer Use with Steel
llm: true
---

This guide shows you how to use Claude models with computer use capabilities and Steel's Computer API to create AI agents that navigate the web.

We'll build a Claude Computer Use loop that enables autonomous web task execution through iterative screenshot analysis and action planning.

#### Prerequisites

*   Python 3.11+

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   An Anthropic API key with access to Claude models


#### Step 1: Setup and Helper Functions

First, set up a virtual environment and install the required packages:

```package-install python
steel-sdk anthropic python-dotenv
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions and constants:

```python Python -wcn -f helpers.py
import os
from typing import List, Optional, Tuple
from datetime import datetime

from dotenv import load_dotenv
from steel import Steel
from anthropic import Anthropic
from anthropic.types.beta import BetaMessageParam

load_dotenv(override=True)

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY") or "your-anthropic-api-key-here"
TASK = os.getenv("TASK") or "Go to Steel.dev and find the latest news"


def format_today() -> str:
    return datetime.now().strftime("%A, %B %d, %Y")


BROWSER_SYSTEM_PROMPT = f"""<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Chromium is already open; interact only through the "computer" tool (mouse, keyboard, scroll, screenshots).
  - Today's date is {format_today()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - When viewing pages, zoom out or scroll so all relevant content is visible.
  - When typing into any input:
    * Clear it first with Ctrl+A, then Delete.
    * After submitting (pressing Enter or clicking a button), take an extra screenshot to confirm the result and move the mouse away.
  - Computer tool calls are slow; batch related actions into a single call whenever possible.
  - You may act on the user's behalf on sites where they are already authenticated.
  - Assume any required authentication/Auth Contexts are already configured before the task starts.
  - If the first screenshot is black:
    * Click near the center of the screen.
    * Take another screenshot.
  - Never click the browser address bar with the mouse. To navigate to a URL:
    * Press Ctrl+L to focus and select the address bar.
    * Type the full URL, then press Enter.
    * If you see any existing text (e.g., 'about:blank'), press Ctrl+L before typing so you replace it (never append).
  - Prefer typing into inputs on the page (e.g., a site's search box) rather than the browser address bar, unless entering a direct URL.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask the user clarifying questions; instead, make reasonable assumptions and proceed.
  - For complex tasks, quickly plan a short, ordered sequence of steps before acting.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Keep your final response concise and focused on fulfilling the task (e.g., a brief summary of findings or results).
  </TASK_EXECUTION>"""


```


#### Step 2: Create the Agent Class

```python Python -wcn -f agent.py
import time
import json
from typing import List, Optional, Tuple

from helpers import (
    STEEL_API_KEY,
    ANTHROPIC_API_KEY,
    BROWSER_SYSTEM_PROMPT,
)
from steel import Steel
from anthropic import Anthropic
from anthropic.types.beta import BetaMessageParam


class Agent:
    def __init__(self):
        self.client = Anthropic(api_key=ANTHROPIC_API_KEY)
        self.steel = Steel(steel_api_key=STEEL_API_KEY)
        self.model = "claude-opus-4-7"
        self.messages: List[BetaMessageParam] = []
        self.session = None
        self.viewport_width = 1280
        self.viewport_height = 768
        self.system_prompt = BROWSER_SYSTEM_PROMPT
        self.tools = [
            {
                "type": "computer_20251124",
                "name": "computer",
                "display_width_px": self.viewport_width,
                "display_height_px": self.viewport_height,
                "display_number": 1,
            }
        ]

    def center(self) -> Tuple[int, int]:
        return (self.viewport_width // 2, self.viewport_height // 2)

    def split_keys(self, k: Optional[str]) -> List[str]:
        return [s.strip() for s in k.split("+")] if k else []

    def normalize_key(self, key: str) -> str:
        if not isinstance(key, str) or not key:
            return key
        k = key.strip()
        upper = k.upper()
        synonyms = {
            "ENTER": "Enter",
            "RETURN": "Enter",
            "ESC": "Escape",
            "ESCAPE": "Escape",
            "TAB": "Tab",
            "BACKSPACE": "Backspace",
            "BKSP": "Backspace",
            "DELETE": "Delete",
            "DEL": "Delete",
            "SPACE": "Space",
            "CTRL": "Control",
            "CONTROL": "Control",
            "ALT": "Alt",
            "SHIFT": "Shift",
            "META": "Meta",
            "SUPER": "Meta",
            "CMD": "Meta",
            "COMMAND": "Meta",
            "UP": "ArrowUp",
            "DOWN": "ArrowDown",
            "LEFT": "ArrowLeft",
            "RIGHT": "ArrowRight",
            "ARROWUP": "ArrowUp",
            "ARROWDOWN": "ArrowDown",
            "ARROWLEFT": "ArrowLeft",
            "ARROWRIGHT": "ArrowRight",
            "HOME": "Home",
            "END": "End",
            "PAGEUP": "PageUp",
            "PAGEDOWN": "PageDown",
            "INSERT": "Insert",
        }
        if upper in synonyms:
            return synonyms[upper]
        if upper.startswith("F") and upper[1:].isdigit():
            return "F" + upper[1:]
        return k

    def normalize_keys(self, keys: List[str]) -> List[str]:
        return [self.normalize_key(k) for k in keys]

    def initialize(self) -> None:
        width = self.viewport_width
        height = self.viewport_height
        self.session = self.steel.sessions.create(
            dimensions={"width": width, "height": height},
            block_ads=True,
            api_timeout=900000,
        )
        print("Steel Session created successfully!")
        print(f"View live session at: {self.session.session_viewer_url}")

    def cleanup(self) -> None:
        if self.session:
            print("Releasing Steel session...")
            self.steel.sessions.release(self.session.id)
            print(
                f"Session completed. View replay at {self.session.session_viewer_url}"
            )

    def take_screenshot(self) -> str:
        resp = self.steel.sessions.computer(self.session.id, action="take_screenshot")
        img = getattr(resp, "base64_image", None)
        if not img:
            raise RuntimeError("No screenshot returned from Input API")
        return img

    def execute_computer_action(
        self,
        action: str,
        text: Optional[str] = None,
        coordinate: Optional[Tuple[int, int]] = None,
        scroll_direction: Optional[str] = None,
        scroll_amount: Optional[int] = None,
        duration: Optional[float] = None,
        key: Optional[str] = None,
    ) -> str:
        if (
            coordinate
            and isinstance(coordinate, (list, tuple))
            and len(coordinate) == 2
        ):
            coords = (int(coordinate[0]), int(coordinate[1]))
        else:
            coords = self.center()

        body: Optional[dict] = None

        if action == "mouse_move":
            body = {
                "action": "move_mouse",
                "coordinates": [coords[0], coords[1]],
                "screenshot": True,
            }
            hk = self.split_keys(key)
            if hk:
                body["hold_keys"] = hk

        elif action in ("left_mouse_down", "left_mouse_up"):
            body = {
                "action": "click_mouse",
                "button": "left",
                "click_type": "down" if action == "left_mouse_down" else "up",
                "coordinates": [coords[0], coords[1]],
                "screenshot": True,
            }
            hk = self.split_keys(key)
            if hk:
                body["hold_keys"] = hk

        elif action in (
            "left_click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
        ):
            button_map = {
                "left_click": "left",
                "right_click": "right",
                "middle_click": "middle",
                "double_click": "left",
                "triple_click": "left",
            }
            clicks = (
                2 if action == "double_click" else 3 if action == "triple_click" else 1
            )
            body = {
                "action": "click_mouse",
                "button": button_map[action],
                "coordinates": [coords[0], coords[1]],
                "screenshot": True,
            }
            if clicks > 1:
                body["num_clicks"] = clicks
            hk = self.split_keys(key)
            if hk:
                body["hold_keys"] = hk

        elif action == "left_click_drag":
            start_x, start_y = self.center()
            end_x, end_y = coords
            body = {
                "action": "drag_mouse",
                "path": [[start_x, start_y], [end_x, end_y]],
                "screenshot": True,
            }
            hk = self.split_keys(key)
            if hk:
                body["hold_keys"] = hk

        elif action == "scroll":
            step = 100
            dx_dy = {
                "down": (0, step * (scroll_amount or 0)),
                "up": (0, -step * (scroll_amount or 0)),
                "right": (step * (scroll_amount or 0), 0),
                "left": (-(step * (scroll_amount or 0)), 0),
            }
            dx, dy = dx_dy.get(
                scroll_direction or "down", (0, step * (scroll_amount or 0))
            )
            body = {
                "action": "scroll",
                "coordinates": [coords[0], coords[1]],
                "delta_x": dx,
                "delta_y": dy,
                "screenshot": True,
            }
            hk = self.split_keys(text)
            if hk:
                body["hold_keys"] = hk

        elif action == "hold_key":
            keys = self.split_keys(text or "")
            keys = self.normalize_keys(keys)
            body = {
                "action": "press_key",
                "keys": keys or [],
                "duration": duration,
                "screenshot": True,
            }

        elif action == "key":
            keys = self.split_keys(text or "")
            keys = self.normalize_keys(keys)
            body = {
                "action": "press_key",
                "keys": keys or [],
                "screenshot": True,
            }

        elif action == "type":
            body = {
                "action": "type_text",
                "text": text,
                "screenshot": True,
            }
            hk = self.split_keys(key)
            if hk:
                body["hold_keys"] = hk

        elif action == "wait":
            body = {
                "action": "wait",
                "duration": duration,
                "screenshot": True,
            }

        elif action == "screenshot":
            return self.take_screenshot()

        elif action == "cursor_position":
            self.steel.sessions.computer(self.session.id, action="get_cursor_position")
            return self.take_screenshot()

        else:
            raise ValueError(f"Invalid action: {action}")

        clean_body = {k: v for k, v in body.items() if v is not None}
        resp = self.steel.sessions.computer(self.session.id, **clean_body)
        img = getattr(resp, "base64_image", None)
        if img:
            return img
        return self.take_screenshot()

    def process_response(self, message) -> Tuple[str, bool]:
        response_text = ""
        has_actions = False
        tool_results = []

        assistant_content = []
        for block in message.content:
            if block.type == "text":
                response_text += block.text
                print(block.text)
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                has_actions = True
                assistant_content.append(
                    {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                )
                tool_name = block.name
                tool_input = block.input
                print(f"🔧 {tool_name}({json.dumps(tool_input)})")

                if tool_name == "computer":
                    action = tool_input.get("action")
                    try:
                        screenshot_base64 = self.execute_computer_action(
                            action=action,
                            text=tool_input.get("text"),
                            coordinate=tool_input.get("coordinate"),
                            scroll_direction=tool_input.get("scroll_direction"),
                            scroll_amount=tool_input.get("scroll_amount"),
                            duration=tool_input.get("duration"),
                            key=tool_input.get("key"),
                        )
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": [
                                    {
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": "image/png",
                                            "data": screenshot_base64,
                                        },
                                    }
                                ],
                            }
                        )
                    except Exception as e:
                        print(f"❌ Error executing {action}: {e}")
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": f"Error executing {action}: {e}",
                                "is_error": True,
                            }
                        )

        self.messages.append({"role": "assistant", "content": assistant_content})
        if tool_results:
            self.messages.append({"role": "user", "content": tool_results})

        return response_text, has_actions

    def execute_task(
        self,
        task: str,
        print_steps: bool = True,
        max_iterations: int = 50,
    ) -> str:
        self.messages = [
            {"role": "user", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]

        iterations = 0
        last_assistant_messages: List[str] = []

        print(f"🎯 Executing task: {task}")
        print("=" * 60)

        def detect_repetition(new_message: str) -> bool:
            if len(last_assistant_messages) < 2:
                return False
            words1 = new_message.lower().split()
            return any(
                len([w for w in words1 if w in prev.lower().split()])
                / max(len(words1), len(prev.lower().split()))
                > 0.8
                for prev in last_assistant_messages
            )

        def extract_text(content) -> str:
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    b.get("text", "") for b in content if b.get("type") == "text"
                )
            return ""

        final_text = ""

        while iterations < max_iterations:
            iterations += 1

            if self.messages:
                last_message = self.messages[-1]
                if last_message.get("role") == "assistant":
                    content = extract_text(last_message.get("content"))
                    if content:
                        if detect_repetition(content):
                            print("🔄 Repetition detected - stopping execution")
                            final_text = content
                            break
                        last_assistant_messages.append(content)
                        if len(last_assistant_messages) > 3:
                            last_assistant_messages.pop(0)

            try:
                response = self.client.beta.messages.create(
                    model=self.model,
                    max_tokens=4096,
                    messages=self.messages,
                    tools=self.tools,
                    betas=["computer-use-2025-11-24"],
                )

                text, has_actions = self.process_response(response)

                if not has_actions:
                    print("✅ Task complete - no further actions requested")
                    final_text = text
                    break

            except Exception as e:
                print(f"❌ Error during task execution: {e}")
                raise e

        if iterations >= max_iterations:
            print(f"⚠️  Task execution stopped after {max_iterations} iterations")

        return final_text or "Task execution completed (no final message)"
```


#### Step 3: Create the Main Script

```python Python -wcn -f main.py
import sys
import time

from helpers import STEEL_API_KEY, ANTHROPIC_API_KEY, TASK
from agent import Agent


def main():
    print("🚀 Steel + Claude Computer Use Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print(
            "⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
        )
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        sys.exit(1)

    if ANTHROPIC_API_KEY == "your-anthropic-api-key-here":
        print(
            "⚠️  WARNING: Please replace 'your-anthropic-api-key-here' with your actual Anthropic API key"
        )
        print("   Get your API key at: https://console.anthropic.com/")
        sys.exit(1)

    print("\nStarting Steel session...")
    agent = Agent()

    try:
        agent.initialize()
        print("✅ Steel session started!")

        start_time = time.time()

        try:
            result = agent.execute_task(TASK, True, 50)
            duration = f"{(time.time() - start_time):.1f}"

            print("\n" + "=" * 60)
            print("🎉 TASK EXECUTION COMPLETED")
            print("=" * 60)
            print(f"⏱️  Duration: {duration} seconds")
            print(f"🎯 Task: {TASK}")
            print(f"📋 Result:\n{result}")
            print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
            raise RuntimeError("Task execution failed")

    except Exception as e:
        print(f"❌ Failed to start Steel session: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")
        raise RuntimeError("Failed to start Steel session")

    finally:
        agent.cleanup()


if __name__ == "__main__":
    main()
```


#### Running Your Agent

Execute your script:

```bash Terminal -wc
python main.py
```

You'll see the session URL printed in the console. Open this URL to view the live browser session.

The agent will execute the task defined in the `TASK` environment variable or the default task.

You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Search for the latest developments in artificial intelligence"
python main.py
```


#### Customizing your agent's task

Try modifying the task to make your agent perform different actions:

```env ENV -wcn -f .env
# Research specific topics
TASK=Go to https://arxiv.org, search for 'computer vision', and summarize the latest papers.

# E-commerce tasks
TASK=Go to https://www.amazon.com, search for 'mechanical keyboards', and compare the top 3 results.

# Information gathering
TASK=Go to https://docs.anthropic.com, find information about Claude's capabilities, and provide a summary.
```


#### Next Steps

*   Explore the [Steel API documentation](https://docs.steel.dev/) for more advanced features

*   Check out the [Anthropic documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) for more information about Claude's computer use capabilities

*   Add additional features like session recording or multi-session management


# Quickstart (Typescript)
URL: /integrations/claude-computer-use/quickstart-ts

---
title: Quickstart (Typescript)
sidebarTitle: Quickstart (Typescript)
description: How to use Claude Computer Use with Steel
llm: true
---

This guide shows you how to create AI agents with Claude's computer use capabilities and Steel's Computer API for autonomous web task execution.

#### Prerequisites

*   Node.js 20+

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   An Anthropic API key with access to Claude models


#### Step 1: Setup and Helper Functions

First, create a project directory and install the required packages:

```bash Terminal -wc
# Create a project directory
mkdir steel-claude-computer-use
cd steel-claude-computer-use

# Initialize package.json
npm init -y

# Install required packages
npm install steel-sdk @anthropic-ai/sdk dotenv
npm install -D @types/node typescript ts-node
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions, constants, and type definitions:

```typescript Typescript -wcn -f helpers.ts
import * as dotenv from "dotenv";
import { Steel } from "steel-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

dotenv.config();

export const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
export const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || "your-anthropic-api-key-here";
export const TASK = process.env.TASK || "Go to Steel.dev and find the latest news";

export function formatToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

export const BROWSER_SYSTEM_PROMPT = `<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Chromium is already open; interact only through the "computer" tool (mouse, keyboard, scroll, screenshots).
  - Today's date is ${formatToday()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - When viewing pages, zoom out or scroll so all relevant content is visible.
  - When typing into any input:
    * Clear it first with Ctrl+A, then Delete.
    * After submitting (pressing Enter or clicking a button), take an extra screenshot to confirm the result and move the mouse away.
  - Computer tool calls are slow; batch related actions into a single call whenever possible.
  - You may act on the user's behalf on sites where they are already authenticated.
  - Assume any required authentication/Auth Contexts are already configured before the task starts.
  - If the first screenshot is black:
    * Click near the center of the screen.
    * Take another screenshot.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask the user clarifying questions; instead, make reasonable assumptions and proceed.
  - For complex tasks, quickly plan a short, ordered sequence of steps before acting.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Keep your final response concise and focused on fulfilling the task (e.g., a brief summary of findings or results).
  </TASK_EXECUTION>`;

export type Coordinates = [number, number];

export interface BaseActionRequest {
  screenshot?: boolean;
  hold_keys?: string[];
}

export type MoveMouseRequest = BaseActionRequest & {
  action: "move_mouse";
  coordinates: Coordinates;
};

export type ClickMouseRequest = BaseActionRequest & {
  action: "click_mouse";
  button: "left" | "right" | "middle";
  coordinates: Coordinates;
  num_clicks?: number;
  click_type?: "down" | "up";
};

export type DragMouseRequest = BaseActionRequest & {
  action: "drag_mouse";
  path: Coordinates[];
};

export type ScrollRequest = BaseActionRequest & {
  action: "scroll";
  coordinates: Coordinates;
  delta_x: number;
  delta_y: number;
};

export type PressKeyRequest = BaseActionRequest & {
  action: "press_key";
  keys: string[];
  duration?: number;
};

export type TypeTextRequest = BaseActionRequest & {
  action: "type_text";
  text: string;
};

export type WaitRequest = BaseActionRequest & {
  action: "wait";
  duration: number;
};

export type GetCursorPositionRequest = {
  action: "get_cursor_position";
};

export type ComputerActionRequest =
  | MoveMouseRequest
  | ClickMouseRequest
  | DragMouseRequest
  | ScrollRequest
  | PressKeyRequest
  | TypeTextRequest
  | WaitRequest
  | GetCursorPositionRequest;

export { Steel, Anthropic, BetaMessageParam, BetaToolResultBlockParam, BetaMessage };
```


#### Step 2: Create the Agent Class

```typescript Typescript -wcn -f agent.ts
import {
  Steel,
  Anthropic,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaMessage,
  STEEL_API_KEY,
  ANTHROPIC_API_KEY,
  BROWSER_SYSTEM_PROMPT,
  Coordinates,
  ComputerActionRequest,
} from "./helpers";

export class Agent {
  private client: Anthropic;
  private steel: Steel;
  private session: Steel.Session | null = null;
  private messages: BetaMessageParam[];
  private tools: any[];
  private model: string;
  private systemPrompt: string;
  private viewportWidth: number;
  private viewportHeight: number;

  constructor() {
    this.client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    this.steel = new Steel({ steelAPIKey: STEEL_API_KEY });
    this.model = "claude-opus-4-7";
    this.messages = [];
    this.viewportWidth = 1280;
    this.viewportHeight = 768;
    this.systemPrompt = BROWSER_SYSTEM_PROMPT;
    this.tools = [
      {
        type: "computer_20251124",
        name: "computer",
        display_width_px: this.viewportWidth,
        display_height_px: this.viewportHeight,
        display_number: 1,
      },
    ];
  }

  private center(): [number, number] {
    return [
      Math.floor(this.viewportWidth / 2),
      Math.floor(this.viewportHeight / 2),
    ];
  }

  private splitKeys(k?: string): string[] {
    return k
      ? k
          .split("+")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  private normalizeKey(key: string): string {
    if (!key) return key;
    const k = String(key).trim();
    const upper = k.toUpperCase();
    const synonyms: Record<string, string> = {
      ENTER: "Enter",
      RETURN: "Enter",
      ESC: "Escape",
      ESCAPE: "Escape",
      TAB: "Tab",
      BACKSPACE: "Backspace",
      BKSP: "Backspace",
      DELETE: "Delete",
      DEL: "Delete",
      SPACE: "Space",
      CTRL: "Control",
      CONTROL: "Control",
      ALT: "Alt",
      SHIFT: "Shift",
      META: "Meta",
      SUPER: "Meta",
      CMD: "Meta",
      COMMAND: "Meta",
      UP: "ArrowUp",
      DOWN: "ArrowDown",
      LEFT: "ArrowLeft",
      RIGHT: "ArrowRight",
      ARROWUP: "ArrowUp",
      ARROWDOWN: "ArrowDown",
      ARROWLEFT: "ArrowLeft",
      ARROWRIGHT: "ArrowRight",
      HOME: "Home",
      END: "End",
      PAGEUP: "PageUp",
      PAGEDOWN: "PageDown",
      INSERT: "Insert",
    };
    if (upper in synonyms) return synonyms[upper];
    if (upper.startsWith("F") && /^\d+$/.test(upper.slice(1))) {
      return "F" + upper.slice(1);
    }
    return k;
  }

  private normalizeKeys(keys: string[]): string[] {
    return keys.map((k) => this.normalizeKey(k));
  }

  async initialize(): Promise<void> {
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    this.session = await this.steel.sessions.create({
      dimensions: { width, height },
      blockAds: true,
      timeout: 900000,
    });
    console.log("Steel Session created successfully!");
    console.log(`View live session at: ${this.session.sessionViewerUrl}`);
  }

  async cleanup(): Promise<void> {
    if (this.session) {
      console.log("Releasing Steel session...");
      await this.steel.sessions.release(this.session.id);
      console.log(
        `Session completed. View replay at ${this.session.sessionViewerUrl}`
      );
    }
  }

  private async takeScreenshot(): Promise<string> {
    const resp: any = await this.steel.sessions.computer(this.session!.id, {
      action: "take_screenshot",
    });
    const img: string | undefined = resp?.base64_image;
    if (!img) throw new Error("No screenshot returned from Input API");
    return img;
  }

  private async executeComputerAction(
    action: string,
    text?: string,
    coordinate?: [number, number] | number[],
    scrollDirection?: "up" | "down" | "left" | "right",
    scrollAmount?: number,
    duration?: number,
    key?: string
  ): Promise<string> {
    const coords: Coordinates =
      coordinate && Array.isArray(coordinate) && coordinate.length === 2
        ? [coordinate[0], coordinate[1]]
        : this.center();

    let body: ComputerActionRequest | null = null;

    switch (action) {
      case "mouse_move": {
        const hk = this.splitKeys(key);
        body = {
          action: "move_mouse",
          coordinates: coords,
          screenshot: true,
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        const hk = this.splitKeys(key);
        body = {
          action: "click_mouse",
          button: "left",
          click_type: action === "left_mouse_down" ? "down" : "up",
          coordinates: coords,
          screenshot: true,
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const buttonMap: Record<string, "left" | "right" | "middle"> = {
          left_click: "left",
          right_click: "right",
          middle_click: "middle",
          double_click: "left",
          triple_click: "left",
        };
        const clicks =
          action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        const hk = this.splitKeys(key);
        body = {
          action: "click_mouse",
          button: buttonMap[action],
          coordinates: coords,
          screenshot: true,
          ...(clicks > 1 ? { num_clicks: clicks } : {}),
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "left_click_drag": {
        const [endX, endY] = coords;
        const [startX, startY] = this.center();
        const hk = this.splitKeys(key);
        body = {
          action: "drag_mouse",
          path: [
            [startX, startY],
            [endX, endY],
          ],
          screenshot: true,
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "scroll": {
        const step = 100;
        type ScrollDir = "up" | "down" | "left" | "right";
        const map: Record<ScrollDir, [number, number]> = {
          down: [0, step * (scrollAmount as number)],
          up: [0, -step * (scrollAmount as number)],
          right: [step * (scrollAmount as number), 0],
          left: [-(step * (scrollAmount as number)), 0],
        };
        const dir: ScrollDir = (scrollDirection || "down") as ScrollDir;
        const [delta_x, delta_y] = map[dir];
        const hk = this.splitKeys(text);
        body = {
          action: "scroll",
          coordinates: coords,
          delta_x,
          delta_y,
          screenshot: true,
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "hold_key": {
        const keys = this.splitKeys(text);
        const normalized = this.normalizeKeys(keys);
        body = {
          action: "press_key",
          keys: normalized,
          duration,
          screenshot: true,
        };
        break;
      }
      case "key": {
        const keys = this.splitKeys(text);
        const normalized = this.normalizeKeys(keys);
        body = {
          action: "press_key",
          keys: normalized,
          screenshot: true,
        };
        break;
      }
      case "type": {
        const hk = this.splitKeys(key);
        body = {
          action: "type_text",
          text: text ?? "",
          screenshot: true,
          ...(hk.length ? { hold_keys: hk } : {}),
        };
        break;
      }
      case "wait": {
        body = {
          action: "wait",
          duration: duration ?? 1000,
          screenshot: true,
        };
        break;
      }
      case "screenshot": {
        return this.takeScreenshot();
      }
      case "cursor_position": {
        await this.steel.sessions.computer(this.session!.id, {
          action: "get_cursor_position",
        });
        return this.takeScreenshot();
      }
      default:
        throw new Error(`Invalid action: ${action}`);
    }

    const resp: any = await this.steel.sessions.computer(
      this.session!.id,
      body!
    );
    const img: string | undefined = resp?.base64_image;
    if (img) return img;
    return this.takeScreenshot();
  }

  private async processResponse(
    message: BetaMessage
  ): Promise<{ text: string; hasActions: boolean }> {
    let responseText = "";
    let hasActions = false;
    const toolResults: BetaToolResultBlockParam[] = [];

    this.messages.push({
      role: "assistant",
      content: message.content as any,
    });

    for (const block of message.content) {
      if (block.type === "text") {
        responseText += block.text;
        console.log(block.text);
      } else if (block.type === "tool_use") {
        hasActions = true;
        const toolName = block.name;
        const toolInput = block.input as any;

        console.log(`🔧 ${toolName}(${JSON.stringify(toolInput)})`);

        if (toolName === "computer") {
          const action = toolInput.action;
          try {
            const screenshotBase64 = await this.executeComputerAction(
              action,
              toolInput.text,
              toolInput.coordinate,
              toolInput.scroll_direction,
              toolInput.scroll_amount,
              toolInput.duration,
              toolInput.key
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: screenshotBase64,
                  },
                },
              ],
            });
          } catch (error) {
            console.log(`❌ Error executing ${action}: ${error}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error executing ${action}: ${String(error)}`,
              is_error: true,
            });
          }
        }
      }
    }

    if (toolResults.length > 0) {
      this.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    return { text: responseText, hasActions };
  }

  async executeTask(
    task: string,
    printSteps: boolean = true,
    maxIterations: number = 50
  ): Promise<string> {
    this.messages = [
      {
        role: "user",
        content: this.systemPrompt,
      },
      {
        role: "user",
        content: task,
      },
    ];

    let iterations = 0;
    let lastAssistantMessages: string[] = [];

    console.log(`🎯 Executing task: ${task}`);
    console.log("=".repeat(60));

    const detectRepetition = (newMessage: string): boolean => {
      if (lastAssistantMessages.length < 2) return false;
      const similarity = (str1: string, str2: string): number => {
        const words1 = str1.toLowerCase().split(/\s/);
        const words2 = str2.toLowerCase().split(/\s+/);
        const commonWords = words1.filter((word) => words2.includes(word));
        return commonWords.length / Math.max(words1.length, words2.length);
      };
      return lastAssistantMessages.some(
        (prevMessage) => similarity(newMessage, prevMessage) > 0.8
      );
    };

    const extractText = (content: any): string => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text ?? "")
        .join("");
    };

    let finalText = "";

    while (iterations < maxIterations) {
      iterations++;

      if (this.messages.length > 0) {
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage?.role === "assistant") {
          const content = extractText(lastMessage.content);
          if (content) {
            if (detectRepetition(content)) {
              console.log("🔄 Repetition detected - stopping execution");
              finalText = content;
              break;
            }
            lastAssistantMessages.push(content);
            if (lastAssistantMessages.length > 3) {
              lastAssistantMessages.shift();
            }
          }
        }
      }

      try {
        const response = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 4096,
          messages: this.messages,
          tools: this.tools,
          betas: ["computer-use-2025-11-24"],
        });

        const { text, hasActions } = await this.processResponse(response);

        if (!hasActions) {
          console.log("✅ Task complete - no further actions requested");
          finalText = text;
          break;
        }
      } catch (error) {
        console.error(`❌ Error during task execution: ${error}`);
        throw error;
      }
    }

    if (iterations >= maxIterations) {
      console.warn(
        `⚠️  Task execution stopped after ${maxIterations} iterations`
      );
    }

    return finalText || "Task execution completed (no final message)";
  }
}
```


#### Step 3: Create the Main Script

```typescript Typescript -wcn -f main.ts
import { Agent } from "./agent";
import { STEEL_API_KEY, ANTHROPIC_API_KEY, TASK } from "./helpers";

async function main(): Promise<void> {
  console.log("🚀 Steel + Claude Computer Use Assistant");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
    );
    console.warn(
      "   Get your API key at: https://app.steel.dev/settings/api-keys"
    );
    throw new Error("Set STEEL_API_KEY");
  }

  if (ANTHROPIC_API_KEY === "your-anthropic-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-anthropic-api-key-here' with your actual Anthropic API key"
    );
    console.warn("   Get your API key at: https://console.anthropic.com/");
    throw new Error("Set ANTHROPIC_API_KEY");
  }

  console.log("\nStarting Steel session...");
  const agent = new Agent();

  try {
    await agent.initialize();
    console.log("✅ Steel session started!");

    const startTime = Date.now();

    try {
      const result = await agent.executeTask(TASK, true, 50);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log("\n" + "=".repeat(60));
      console.log("🎉 TASK EXECUTION COMPLETED");
      console.log("=".repeat(60));
      console.log(`⏱️  Duration: ${duration} seconds`);
      console.log(`🎯 Task: ${TASK}`);
      console.log(`📋 Result:\n${result}`);
      console.log("=".repeat(60));
    } catch (error) {
      console.error(`❌ Task execution failed: ${error}`);
      throw new Error("Task execution failed");
    }
  } catch (error) {
    console.log(`❌ Failed to start Steel session: ${error}`);
    console.log("Please check your STEEL_API_KEY and internet connection.");
    throw new Error("Failed to start Steel session");
  } finally {
    await agent.cleanup();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Task execution failed:", error);
    process.exit(1);
  });
```


#### Running Your Agent

Execute your script:

```bash Terminal -wc
npx ts-node main.ts
```

You'll see the session URL printed in the console. Open this URL to view the live browser session.

The agent will execute the task defined in the `TASK` environment variable or the default task.

You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Research the latest developments in artificial intelligence"
npx ts-node main.ts
```


#### Customizing your agent's task

Try modifying the task to make your agent perform different actions:

```env ENV -wcn -f .env
# Research specific topics
TASK=Go to https://arxiv.org, search for 'machine learning', and summarize the latest papers.

# E-commerce tasks
TASK=Go to https://www.amazon.com, search for 'wireless headphones', and compare the top 3 results.

# Information gathering
TASK=Go to https://docs.anthropic.com, find information about Claude's capabilities, and provide a summary.
```


#### Next Steps

*   Explore the [Steel API documentation](https://docs.steel.dev/) for more advanced features

*   Check out the [Anthropic documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) for more information about Claude's computer use capabilities

*   Add additional features like session recording or multi-session management


# Claude Code
URL: /integrations/coding-agents/claude-code

---
title: Claude Code
sidebarTitle: Claude Code
description: Use Claude Code with Steel CLI to drive real browser sessions, scrape rendered pages, and monitor browser workflows from the terminal.
llm: true
---

### Overview

The Claude Code integration uses Steel CLI as a terminal tool through agent skill steel-browser. This lets Claude Code:

*   Start and control Steel browser sessions from the Claude session
*   Scrape fully rendered pages and perform computer-use actions
*   Inspect live browser state with snapshots and the Steel session viewer
*   Turn successful browser runs into repeatable scripts or project-specific workflows

Claude Code already works well with local tools and shell commands. Steel extends that model with a real cloud browser for sites that need JavaScript, session state, or interactive navigation.

### Requirements

*   **Node.js**: Version 18 or higher
*   **Claude Code**: Installed locally
*   **Steel CLI**: Installed locally
*   **Steel API Key**: Active Steel account

### Setup

#### Step 1: Install Steel CLI

```bash Terminal
curl -LsSf https://setup.steel.dev | sh
```

#### Step 2: Log in

```bash Terminal
steel login
```

#### Step 3: Install the browser skill (recommended)

The `steel-browser` skill gives Claude Code better command discovery and more reliable browser workflows.

```bash Terminal
npx skills add https://github.com/steel-dev/cli --skill steel-browser
```

Restart Claude Code after installing so it can discover the skill.

Once Steel CLI is available, Claude Code can use it directly:

### Authenticated workflows

For authenticated sites, it is better to prepare reusable auth state in Steel ahead of time rather than asking Claude Code to handle login from scratch during every run.

See:

*   [Profiles API](/overview/profiles-api/overview)
*   [Reusing Auth Context](/overview/sessions-api/reusing-auth-context)


### Live debugging

Steel sessions return a viewer URL that makes it easier to monitor what the agent is doing in real time. This is useful when Claude Code reaches a modal, a sign-in wall, or a page that does not behave as expected.

### Repeatable workflows

After a successful run, Claude Code can help turn the browser workflow into something more repeatable:

*   A bash script for local execution
*   A project-specific command or workflow
*   A documented runbook for recurring tasks

### Constraints

*   **Command approvals depend on your Claude Code settings.** Shell access may require approval depending on your permission mode.
*   **First runs are usually the roughest.** Dynamic web apps often need a few retries before the workflow is stable.
*   **Authenticated sites work best with prepared Steel auth state.** Reusing profiles or auth context is generally more reliable than repeated interactive logins.


### Additional Resources

*   [Give Claude Code a real browser](https://steel.dev/blog/give-claude-code-a-real-browser) – Blog post on using Claude Code with Steel
*   [Claude Code overview](https://code.claude.com/docs/en/overview) – Official Claude Code documentation
*   [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) – Built-in tools, permissions, and execution model
*   [Steel CLI docs](/overview/steel-cli) – Full command reference and workflows
*   [Steel browser skill](https://github.com/steel-dev/cli/tree/main/skills/steel-browser) – Skill package for coding agents
*   [Discord](https://discord.gg/steel-dev) – Get help and share what you build


# Codex
URL: /integrations/coding-agents/codex

---
title: Codex
sidebarTitle: Codex
description: Use Codex with Steel CLI to scrape pages, run browser sessions, and automate browser workflows from the terminal.
llm: true
---

### Overview

The Codex integration uses Steel CLI as a terminal tool inside Codex with the help of steel-browser agent skill. This lets Codex:

*   Start and control Steel browser sessions from the Codex session
*   Scrape fully rendered pages and perform computer-use actions
*   Inspect live browser state with snapshots and the Steel session viewer
*   Turn one-off browser runs into reusable scripts

Codex and Steel fit together well because both are command-line tools. Once Steel CLI is installed and available on `PATH`, Codex can inspect command help, run the commands it needs, and verify results from the terminal.

### Requirements

*   **Node.js**: Version 18 or higher
*   **Codex CLI**: Installed locally
*   **Steel CLI**: Installed locally
*   **Steel API Key**: Active Steel account

### Setup

#### Step 1: Install Steel CLI

```bash Terminal
curl -LsSf https://setup.steel.dev | sh
```

#### Step 2: Log in

```bash Terminal
steel login
```

#### Step 3: Install the browser skill (recommended)

The `steel-browser` skill gives Codex better command discovery and more consistent browser workflows.

```bash Terminal
npx skills add https://github.com/steel-dev/cli --skill steel-browser
```

Restart Codex after installing so it can discover the skill.

This gives Codex a real browser loop for navigation, clicking, form entry, and session-aware browsing.

### Automation workflow

After a successful manual run, you can ask Codex to turn the workflow into a script:

```
Write a bash script based on what you just did.
```

That works well for jobs like recurring research, internal reporting, or lightweight monitoring. A common pattern is:

1.  Run the task once interactively
2.  Convert it into a script
3.  Schedule it with cron or another runner

### Constraints

*   **Command approvals depend on your Codex settings.** Codex may ask before running shell commands unless you have configured a more permissive approval mode.
*   **Authenticated workflows usually need preconfigured Steel auth state.** For reusable login state, see [Profiles API](/overview/profiles-api/overview) and [Reusing Auth Context](/overview/sessions-api/reusing-auth-context).


### Additional Resources

*   [Codex + Steel + Resend blog post](https://steel.dev/blog/codex-wired-steel-and-resend-into-a-daily-newsletter) – Example workflow for building a daily newsletter with Codex
*   [Codex CLI docs](https://developers.openai.com/codex/cli) – Install and use Codex locally
*   [Steel CLI docs](/overview/steel-cli) – Full command reference and workflows
*   [Steel browser skill](https://github.com/steel-dev/cli/tree/main/skills/steel-browser) – Skill package for coding agents
*   [Get a free API key](https://app.steel.dev) – Sign up and start a session
*   [Discord](https://discord.gg/steel-dev) – Get help and share what you build


# Hermes Agent
URL: /integrations/coding-agents/hermes-agent

---
title: Hermes Agent
sidebarTitle: Hermes Agent
description: Hermes Agent has a pending Steel integration that adds Steel as a cloud browser provider. This page tracks the proposed workflow and links to the upstream pull request.
llm: true
---

:::callout
The Steel integration for Hermes is currently pending upstream. It is being developed in [NousResearch/hermes-agent PR #5555](https://github.com/NousResearch/hermes-agent/pull/5555) and may change before it lands in a Hermes release. Upvote or comment on the PR to signal interest.
:::

### Overview

The pending Hermes integration adds Steel as a cloud browser provider inside Hermes. Based on the current upstream pull request, the integration is expected to provide:

*   Steel as a selectable browser provider during Hermes setup
*   Steel-backed browser sessions for web navigation and interaction
*   A `steel_scrape` tool for server-side content extraction
*   Support for Steel-specific options such as proxying and CAPTCHA solving
*   Viewer URL support so you can monitor browser sessions while the agent runs

If this ships as proposed, Hermes users will be able to route browser tasks through Steel by setting `STEEL_API_KEY` and selecting Steel in Hermes configuration.

### Requirements

*   **Hermes Agent**: A build that includes the Steel integration from PR #5555 or a future release that ships it
*   **Steel API Key**: Active Steel account

### Expected setup flow

The workflow below reflects the current pull request, not a released Hermes build.

```bash Terminal
hermes setup
```

During setup:

1.  Choose your model provider
2.  Select Steel as the browser provider
3.  Add your `STEEL_API_KEY`

If you are using a current release of Hermes and do not see Steel in the setup flow, that is expected until the integration lands upstream. To try it now, check out the PR branch and run Hermes from source.

### Expected workflow

Once the integration is available, Hermes should be able to use Steel for tasks that need a real browser:

```
Find a hotel near Grand Central and compare the top options.
```

In the proposed implementation, Hermes would start a Steel session, browse the relevant sites, and return a viewer URL alongside the task output so you can inspect the session while it runs.

### Constraints

*   **This integration is not yet part of a released Hermes build.** Check the upstream PR or Hermes changelog before relying on it.
*   **The setup flow may change before release.** Provider names, environment variables, or supported options may still be updated.
*   **Documentation should be validated against the released Hermes version once the PR lands.**

### Additional Resources

*   [Steel is now a native browser provider in Hermes](https://steel.dev/blog/steel-is-now-a-native-browser-provider-in-hermes) – Blog post covering the Hermes integration
*   [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) – Upstream project
*   [Steel integration PR #5555](https://github.com/NousResearch/hermes-agent/pull/5555) – Proposed Steel provider implementation
*   [Steel CLI docs](/overview/steel-cli) – Steel browser workflows from the terminal
*   [Steel Sessions API Reference](/api-reference) – Programmatic session management
*   [Discord](https://discord.gg/steel-dev) – Get help and share what you build


# OpenClaw
URL: /integrations/coding-agents/openclaw

---
title: OpenClaw
sidebarTitle: OpenClaw
description: Use OpenClaw with Steel CLI to run real browser sessions, inspect live web state, and automate form-heavy workflows from the terminal.
llm: true
---

### Overview

The OpenClaw integration uses Steel CLI as a terminal tool inside OpenClaw. This lets OpenClaw:

*   Start and control Steel browser sessions for multi-step web tasks

*   Use `steel scrape` for rendered page extraction when interaction is not required

*   Monitor live browser state through Steel's session viewer

*   Work through real forms, dynamic pages, and browser-based workflows without writing custom integration code


Once Steel CLI is installed and available on `PATH`, OpenClaw can use it like any other terminal tool. That makes it a good fit for tasks like application forms, operational workflows, and browser-driven research.

### Requirements

*   **Node.js**: Version 18 or higher

*   **OpenClaw**: Installed locally

*   **Steel CLI**: Installed locally

*   **Steel API Key**: Active Steel account


### Setup

#### Step 1: Install Steel CLI

```bash Terminal
curl -LsSf https://setup.steel.dev | sh
```

#### Step 2: Log in

```bash Terminal
steel login
```

#### Step 3: Install the browser skill (recommended)

The `steel-browser` skill gives OpenClaw better command discovery and more reliable browser workflows.

```bash Terminal
npx skills add github:steel-dev/cli/skills/steel-browser
```

Restart OpenClaw after installing so it can discover the skill.

### Example workflow

OpenClaw works well on browser tasks that need real interaction. One example is filling out a conference CFP form: finding the right page, inspecting the fields, drafting responses, and working through the submission flow.

You can start with a prompt like:

```
I would like to submit an application for the call for speakers for AI Engineer World's Fair. Could you figure out what the fields are, what we need, and how I can apply to become a speaker?
```

From there, OpenClaw can start a Steel session, navigate the form, inspect fields with snapshots, and work through the page step by step.

### Watching the session

Steel sessions return a viewer URL so you can watch the browser while the agent works. This is useful on form-heavy flows, especially when the page changes dynamically, a modal blocks progress, or the agent needs a second attempt to recover from a mistake.

For longer workflows, Steel also keeps the full session history so you can inspect what happened after the fact.

### Where OpenClaw works best

OpenClaw is a strong fit for:

*   Standard web forms

*   Multi-step browser workflows

*   Pages that need JavaScript rendering before the agent can reason about them


For tasks that only need page content, `steel scrape` is often the faster option:

```bash Terminal
steel scrape https://example.com
```

### Authenticated workflows

For sites behind login, it is usually better to prepare reusable auth state in Steel ahead of time rather than asking the agent to log in from scratch every time.

See:

*   [Profiles API](/overview/profiles-api/overview)

*   [Reusing Auth Context](/overview/sessions-api/reusing-auth-context)


### Constraints

*   **Command approvals depend on your OpenClaw settings.** Shell access may require approval depending on your configuration.

*   **Form-heavy workflows can still take time.** Dynamic fields, validation errors, and bot checks add retries and extra browser steps.

*   **Authenticated sites work best with prepared Steel auth state.** Reusing profiles or auth context is generally more reliable than repeated interactive logins.


### Additional Resources

*   [OpenClaw + Steel blog post](https://steel.dev/blog/openclaw-steel-browser-let-your-ai-agent-fill-the-forms) – Case study using OpenClaw to work through a CFP submission flow

*   [Steel CLI docs](/overview/steel-cli) – Full command reference and workflows

*   [Steel browser skill](https://github.com/steel-dev/cli/tree/main/skills/steel-browser) – Skill package for coding agents

*   [Get a free API key](https://app.steel.dev) – Sign up and start a session

*   [Discord](https://discord.gg/steel-dev) – Get help and share what you build


# Pi Agent
URL: /integrations/coding-agents/pi-agent

---
title: Pi Agent
sidebarTitle: Pi Agent
description: Use Pi with the pi-steel extension to drive real browser sessions, scrape rendered pages, extract structured data, and run computer actions from the terminal.
llm: true
---

:::callout
This integration is part of Steel's experiments effort. Defaults can change without notice, and stability is not guaranteed.
:::

### Overview

The Pi integration uses Steel as a native Pi extension through the `@steel-experiments/pi-steel` package. This lets Pi:

*   Start and control Steel browser sessions from the Pi session
*   Scrape fully rendered pages and perform computer-use actions
*   Extract structured data with a JSON schema instead of parsing markdown
*   Capture screenshots and PDFs as Pi artifacts
*   Fill and submit forms, and reuse sessions across prompts

[Pi](https://pi.dev/) is a minimal, extension-first coding agent. It ships with no built-in browser, so capabilities arrive through `pi install`. Steel plugs into that socket and hands Pi a real cloud browser without any Playwright or headless Chromium setup on your side.

### Requirements

*   **Node.js**: Version 18 or higher
*   **Pi**: Installed locally
*   **Steel API Key**: Active Steel account

### Setup

#### Step 1: Install the extension

```bash Terminal
pi install npm:@steel-experiments/pi-steel
```

Pi picks up the extension on the next run and the Steel browser tools become available automatically.

#### Step 2: Authenticate

Set `STEEL_API_KEY` in your environment.

Grab a free API key at [app.steel.dev](https://app.steel.dev) if you do not have one yet.

### Available tools

Once the extension is installed, Pi has access to a full browser toolset:

*   `steel_navigate` and `steel_scrape` for fetching pages as text, markdown, or HTML
*   `steel_extract` for structured data from a JSON schema
*   `steel_fill_form` for submitting forms
*   Playwright-backed computer actions (click, scroll, type) for pages that scraping cannot reach
*   Screenshot and PDF capture, returned as Pi artifacts
*   `steel_pin_session` to keep a browser alive across prompts, or `STEEL_SESSION_MODE=session` for persistent mode

CAPTCHA handling is built in, so most bot-protected pages work without extra configuration.

### Example workflow

Pi works well on research tasks that span multiple pages and require both scraping and interaction. A prompt like:

```
Visit apple.com and compare all recent MacBook models.
```

Pi will navigate the Mac lineup, follow links into each model page, and fall back to computer actions and screenshots when sticky navigation or viewport-dependent sections block plain scraping.

For bot-protected docs:

```
Visit OpenAI docs and tell us how we can use the latest model.
```

Steel handles the bot-protection layer so Pi sees a normal webpage, reads the current API reference, and returns an up-to-date code example rather than a stale one from training data.

### Structured extraction

When you would otherwise parse markdown for prices, specs, or listings, `steel_extract` with a JSON schema is usually the better call. Pi gets typed output directly, which is easier to reason about across multi-step workflows.

### Constraints

*   **Command approvals depend on your Pi settings.** Extension tools may require approval depending on your configuration.
*   **First runs are usually the roughest.** Dynamic web apps often need a few retries before the workflow is stable.
*   **Authenticated sites work best with prepared Steel auth state.** Reusing profiles or auth context is generally more reliable than repeated interactive logins.

### Additional Resources

*   [pi-steel: we gave Pi a real browser in one command](https://steel.dev/blog/pi-agent-steel-browser) – Blog post on the extension and example runs
*   [`@steel-experiments/pi-steel` on GitHub](https://github.com/steel-experiments/pi-steel) – Source and issues
*   [`@steel-experiments/pi-steel` on npm](https://www.npmjs.com/package/@steel-experiments/pi-steel) – Package page
*   [Steel CLI docs](/overview/steel-cli) – Full command reference and workflows
*   [Get a free API key](https://app.steel.dev) – Sign up and start a session
*   [Discord](https://discord.gg/steel-dev) – Get help and share what you build


# Overview
URL: /integrations/gemini-computer-use/overview

---
title: Overview
sidebarTitle: Overview
description: Gemini's Computer Use is an agent that combines vision capabilities with advanced reasoning to control computer interfaces and perform tasks on behalf of users through a continuous action loop.
llm: true
---
### Overview

The Gemini Computer Use integration allows you to connect Gemini 3's vision and reasoning capabilities with Steel's reliable browser infrastructure. This integration enables AI agents to:

*   Control Steel browser sessions via the Gemini API

*   Execute real browser actions like clicking, typing, and scrolling

*   Perform complex web tasks such as form filling, searching, and navigation

*   Process visual feedback from screenshots to determine next actions

*   Handle normalized coordinate systems automatically


By combining Gemini's Computer Use with Steel's cloud browser infrastructure, you can build robust, scalable web automation solutions that leverage Steel's anti-bot capabilities, proxy management, and sandboxed environments.

### Requirements & Limitations

*   **Gemini API Key**: Access to the Gemini API with the `gemini-3-flash-preview` model (which has built-in computer use)

*   **Steel API Key**: Active subscription to Steel

*   **Python/Node Environment**: Support for API clients for both services

*   **Supported Environments**: Works best with Steel's browser environment


### Documentation

[Quickstart Guide (Python)](/integrations/gemini-computer-use/quickstart-py) → Step-by-step guide to building a Simple CUA agent with Steel browser sessions in Python.

[Quickstart Guide (Node)](/integrations/gemini-computer-use/quickstart-ts) → Step-by-step guide to building a Simple CUA agent with Steel browser sessions in Typescript & Node.

### Additional Resources

*   [Gemini Computer Use Documentation](https://ai.google.dev/gemini-api/docs/computer-use) - Official documentation from Google

*   [Steel Sessions API Reference](/api-reference) - Technical details for managing Steel browser sessions

*   [Cookbook Recipe (Python)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-gemini-computer-use-python-starter) - Working, forkable examples of the integration in Python

*   [Cookbook Recipe (TS/Node)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-gemini-computer-use-node-starter) - Working, forkable examples of the integration in TypeScript

*   [Community Discord](https://discord.gg/steel-dev) - Get help and share your implementations





# Quickstart (Python)
URL: /integrations/gemini-computer-use/quickstart-py

---
title: Quickstart (Python)
sidebarTitle: Quickstart (Python)
description: How to use Gemini Computer Use with Steel
llm: true
---

This guide will walk you through how to use Google's `gemini-3-flash-preview` model (with built-in computer use) and Steel's Computer API to create AI agents that can navigate the web.

Gemini's Computer Use model uses a normalized coordinate system (0-1000) and provides built-in actions for browser control, making it straightforward to integrate with Steel.

#### Prerequisites

*   Python 3.8+

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   A Gemini API key ([get one here](https://aistudio.google.com/apikey))


#### Step 1: Setup and Helper Functions

First, set up a virtual environment and install the required packages:

```package-install python
steel-sdk google-genai python-dotenv
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions and constants:

```python Python -wcn -f helpers.py
import os
import json
from typing import List, Optional, Tuple, Dict, Any
from datetime import datetime

from dotenv import load_dotenv
from steel import Steel
from google import genai
from google.genai import types
from google.genai.types import (
    Content,
    Part,
    FunctionCall,
    FunctionResponse,
    Candidate,
    FinishReason,
    Tool,
    GenerateContentConfig,
)

load_dotenv(override=True)

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or "your-gemini-api-key-here"
TASK = os.getenv("TASK") or "Go to Steel.dev and find the latest news"

MAX_COORDINATE = 1000


def format_today() -> str:
    return datetime.now().strftime("%A, %B %d, %Y")


BROWSER_SYSTEM_PROMPT = f"""<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Chromium is already open; interact only through computer use actions (mouse, keyboard, scroll, screenshots).
  - Today's date is {format_today()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - When viewing pages, zoom out or scroll so all relevant content is visible.
  - When typing into any input:
    * Clear it first with Ctrl+A, then Delete.
    * After submitting (pressing Enter or clicking a button), wait for the page to load.
  - Computer tool calls are slow; batch related actions into a single call whenever possible.
  - You may act on the user's behalf on sites where they are already authenticated.
  - Assume any required authentication/Auth Contexts are already configured before the task starts.
  - If the first screenshot is black:
    * Click near the center of the screen.
    * Take another screenshot.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask the user clarifying questions; instead, make reasonable assumptions and proceed.
  - For complex tasks, quickly plan a short, ordered sequence of steps before acting.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Keep your final response concise and focused on fulfilling the task (e.g., a brief summary of findings or results).
  </TASK_EXECUTION>"""
```


#### Step 2: Create the Agent Class

```python Python -wcn -f agent.py
import json
import re
from typing import List, Optional, Tuple, Dict, Any

from helpers import (
    STEEL_API_KEY,
    GEMINI_API_KEY,
    MAX_COORDINATE,
    BROWSER_SYSTEM_PROMPT,
)
from steel import Steel
from google import genai
from google.genai import types
from google.genai.types import (
    Content,
    Part,
    FunctionCall,
    FunctionResponse,
    Candidate,
    FinishReason,
    Tool,
    GenerateContentConfig,
)


class Agent:
    def __init__(self):
        self.client = genai.Client(api_key=GEMINI_API_KEY)
        self.steel = Steel(steel_api_key=STEEL_API_KEY)
        self.model = "gemini-3-flash-preview"
        self.session = None
        self.contents: List[Content] = []
        self.current_url = "about:blank"
        self.viewport_width = 1440
        self.viewport_height = 900
        self.tools: List[Tool] = [
            Tool(
                computer_use=types.ComputerUse(
                    environment=types.Environment.ENVIRONMENT_BROWSER,
                )
            )
        ]
        self.config = GenerateContentConfig(tools=self.tools)

    def denormalize_x(self, x: int) -> int:
        return int(x / MAX_COORDINATE * self.viewport_width)

    def denormalize_y(self, y: int) -> int:
        return int(y / MAX_COORDINATE * self.viewport_height)

    def center(self) -> Tuple[int, int]:
        return (self.viewport_width // 2, self.viewport_height // 2)

    def split_keys(self, k: Optional[str]) -> List[str]:
        return [s.strip() for s in k.split("+") if s.strip()] if k else []

    def normalize_key(self, key: str) -> str:
        if not isinstance(key, str) or not key:
            return key
        k = key.strip()
        upper = k.upper()
        synonyms = {
            "ENTER": "Enter",
            "RETURN": "Enter",
            "ESC": "Escape",
            "ESCAPE": "Escape",
            "TAB": "Tab",
            "BACKSPACE": "Backspace",
            "BKSP": "Backspace",
            "DELETE": "Delete",
            "DEL": "Delete",
            "SPACE": "Space",
            "CTRL": "Control",
            "CONTROL": "Control",
            "ALT": "Alt",
            "SHIFT": "Shift",
            "META": "Meta",
            "SUPER": "Meta",
            "CMD": "Meta",
            "COMMAND": "Meta",
            "UP": "ArrowUp",
            "DOWN": "ArrowDown",
            "LEFT": "ArrowLeft",
            "RIGHT": "ArrowRight",
            "ARROWUP": "ArrowUp",
            "ARROWDOWN": "ArrowDown",
            "ARROWLEFT": "ArrowLeft",
            "ARROWRIGHT": "ArrowRight",
            "HOME": "Home",
            "END": "End",
            "PAGEUP": "PageUp",
            "PAGEDOWN": "PageDown",
            "INSERT": "Insert",
        }
        if upper in synonyms:
            return synonyms[upper]
        if upper.startswith("F") and upper[1:].isdigit():
            return "F" + upper[1:]
        return k

    def normalize_keys(self, keys: List[str]) -> List[str]:
        return [self.normalize_key(k) for k in keys]

    def initialize(self) -> None:
        self.session = self.steel.sessions.create(
            dimensions={"width": self.viewport_width, "height": self.viewport_height},
            block_ads=True,
            api_timeout=900000,
        )
        print("Steel Session created successfully!")
        print(f"View live session at: {self.session.session_viewer_url}")

    def cleanup(self) -> None:
        if self.session:
            print("Releasing Steel session...")
            self.steel.sessions.release(self.session.id)
            print(
                f"Session completed. View replay at {self.session.session_viewer_url}"
            )
            self.session = None

    def take_screenshot(self) -> str:
        resp = self.steel.sessions.computer(self.session.id, action="take_screenshot")
        img = getattr(resp, "base64_image", None)
        if not img:
            raise RuntimeError("No screenshot returned from Steel")
        return img

    def execute_computer_action(
        self, function_call: FunctionCall
    ) -> Tuple[str, Optional[str]]:
        """Execute a computer action and return (screenshot_base64, url)."""
        name = function_call.name or ""
        args: Dict[str, Any] = function_call.args or {}

        if name == "open_web_browser":
            screenshot = self.take_screenshot()
            return screenshot, self.current_url

        elif name == "click_at":
            x = self.denormalize_x(args.get("x", 0))
            y = self.denormalize_y(args.get("y", 0))
            resp = self.steel.sessions.computer(
                self.session.id,
                action="click_mouse",
                button="left",
                coordinates=[x, y],
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "hover_at":
            x = self.denormalize_x(args.get("x", 0))
            y = self.denormalize_y(args.get("y", 0))
            resp = self.steel.sessions.computer(
                self.session.id,
                action="move_mouse",
                coordinates=[x, y],
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "type_text_at":
            x = self.denormalize_x(args.get("x", 0))
            y = self.denormalize_y(args.get("y", 0))
            text = args.get("text", "")
            press_enter = args.get("press_enter", True)
            clear_before_typing = args.get("clear_before_typing", True)

            self.steel.sessions.computer(
                self.session.id,
                action="click_mouse",
                button="left",
                coordinates=[x, y],
            )

            if clear_before_typing:
                self.steel.sessions.computer(
                    self.session.id,
                    action="press_key",
                    keys=["Control", "a"],
                )
                self.steel.sessions.computer(
                    self.session.id,
                    action="press_key",
                    keys=["Backspace"],
                )

            self.steel.sessions.computer(
                self.session.id,
                action="type_text",
                text=text,
            )

            if press_enter:
                self.steel.sessions.computer(
                    self.session.id,
                    action="press_key",
                    keys=["Enter"],
                )

            self.steel.sessions.computer(
                self.session.id,
                action="wait",
                duration=1,
            )

            screenshot = self.take_screenshot()
            return screenshot, self.current_url

        elif name == "scroll_document":
            direction = args.get("direction", "down")

            if direction == "down":
                keys = ["PageDown"]
            elif direction == "up":
                keys = ["PageUp"]
            elif direction in ("left", "right"):
                cx, cy = self.center()
                delta = -400 if direction == "left" else 400
                resp = self.steel.sessions.computer(
                    self.session.id,
                    action="scroll",
                    coordinates=[cx, cy],
                    delta_x=delta,
                    delta_y=0,
                    screenshot=True,
                )
                img = getattr(resp, "base64_image", None)
                return img or self.take_screenshot(), self.current_url
            else:
                keys = ["PageDown"]

            resp = self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=keys,
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "scroll_at":
            x = self.denormalize_x(args.get("x", 0))
            y = self.denormalize_y(args.get("y", 0))
            direction = args.get("direction", "down")
            magnitude = self.denormalize_y(args.get("magnitude", 800))

            delta_x, delta_y = 0, 0
            if direction == "down":
                delta_y = magnitude
            elif direction == "up":
                delta_y = -magnitude
            elif direction == "right":
                delta_x = magnitude
            elif direction == "left":
                delta_x = -magnitude

            resp = self.steel.sessions.computer(
                self.session.id,
                action="scroll",
                coordinates=[x, y],
                delta_x=delta_x,
                delta_y=delta_y,
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "wait_5_seconds":
            resp = self.steel.sessions.computer(
                self.session.id,
                action="wait",
                duration=5,
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "go_back":
            resp = self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Alt", "ArrowLeft"],
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "go_forward":
            resp = self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Alt", "ArrowRight"],
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "search":
            self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Control", "l"],
            )
            self.steel.sessions.computer(
                self.session.id,
                action="type_text",
                text="https://www.google.com",
            )
            self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Enter"],
            )
            self.steel.sessions.computer(
                self.session.id,
                action="wait",
                duration=2,
            )
            self.current_url = "https://www.google.com"
            screenshot = self.take_screenshot()
            return screenshot, self.current_url

        elif name == "navigate":
            url = args.get("url", "")
            if not url.startswith(("http://", "https://")):
                url = "https://" + url

            self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Control", "l"],
            )
            self.steel.sessions.computer(
                self.session.id,
                action="type_text",
                text=url,
            )
            self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=["Enter"],
            )
            self.steel.sessions.computer(
                self.session.id,
                action="wait",
                duration=2,
            )

            self.current_url = url
            screenshot = self.take_screenshot()
            return screenshot, self.current_url

        elif name == "key_combination":
            keys_str = args.get("keys", "")
            normalized_keys = self.normalize_keys(self.split_keys(keys_str))

            resp = self.steel.sessions.computer(
                self.session.id,
                action="press_key",
                keys=normalized_keys,
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        elif name == "drag_and_drop":
            start_x = self.denormalize_x(args.get("x", 0))
            start_y = self.denormalize_y(args.get("y", 0))
            end_x = self.denormalize_x(args.get("destination_x", 0))
            end_y = self.denormalize_y(args.get("destination_y", 0))

            resp = self.steel.sessions.computer(
                self.session.id,
                action="drag_mouse",
                path=[[start_x, start_y], [end_x, end_y]],
                screenshot=True,
            )
            img = getattr(resp, "base64_image", None)
            return img or self.take_screenshot(), self.current_url

        else:
            print(f"Unknown action: {name}, taking screenshot")
            screenshot = self.take_screenshot()
            return screenshot, self.current_url

    def extract_function_calls(self, candidate: Candidate) -> List[FunctionCall]:
        function_calls: List[FunctionCall] = []
        if not candidate.content or not candidate.content.parts:
            return function_calls

        for part in candidate.content.parts:
            if part.function_call:
                function_calls.append(part.function_call)

        return function_calls

    def extract_text(self, candidate: Candidate) -> str:
        if not candidate.content or not candidate.content.parts:
            return ""
        texts: List[str] = []
        for part in candidate.content.parts:
            # Gemini 3 Flash occasionally emits stray digit/whitespace-only
            # text parts (e.g. "0", "00") alongside the real response.
            if part.text and not re.fullmatch(r"[\s\d]*", part.text):
                texts.append(part.text)
        return " ".join(texts).strip()

    def build_function_response_parts(
        self,
        function_calls: List[FunctionCall],
        results: List[Tuple[str, Optional[str]]],
    ) -> List[Part]:
        parts: List[Part] = []

        for i, fc in enumerate(function_calls):
            screenshot_base64, url = results[i]

            function_response = FunctionResponse(
                name=fc.name or "",
                response={"url": url or self.current_url},
            )
            parts.append(Part(function_response=function_response))
            parts.append(
                Part(
                    inline_data=types.Blob(
                        mime_type="image/png",
                        data=screenshot_base64,
                    )
                )
            )

        return parts

    def execute_task(
        self,
        task: str,
        print_steps: bool = True,
        max_iterations: int = 50,
    ) -> str:
        self.contents = [
            Content(
                role="user",
                parts=[Part(text=BROWSER_SYSTEM_PROMPT), Part(text=task)],
            )
        ]

        iterations = 0
        consecutive_no_actions = 0

        print(f"🎯 Executing task: {task}")
        print("=" * 60)

        while iterations < max_iterations:
            iterations += 1

            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=self.contents,
                    config=self.config,
                )

                if not response.candidates:
                    print("❌ No candidates in response")
                    break

                candidate = response.candidates[0]

                if candidate.content:
                    self.contents.append(candidate.content)

                reasoning = self.extract_text(candidate)
                function_calls = self.extract_function_calls(candidate)

                if (
                    not function_calls
                    and not reasoning
                    and candidate.finish_reason == FinishReason.MALFORMED_FUNCTION_CALL
                ):
                    print("⚠️ Malformed function call, retrying...")
                    continue

                if not function_calls:
                    if reasoning:
                        if print_steps:
                            print(f"\n💬 {reasoning}")
                        print("✅ Task complete - model provided final response")
                        break

                    consecutive_no_actions += 1
                    if consecutive_no_actions >= 3:
                        print("⚠️ No actions for 3 consecutive iterations - stopping")
                        break
                    continue

                consecutive_no_actions = 0

                if print_steps and reasoning:
                    print(f"\n💭 {reasoning}")

                results: List[Tuple[str, Optional[str]]] = []

                for fc in function_calls:
                    action_name = fc.name or "unknown"
                    action_args = fc.args or {}

                    if print_steps:
                        print(f"🔧 {action_name}({json.dumps(action_args)})")

                    if action_args:
                        safety_decision = action_args.get("safety_decision")
                        if (
                            isinstance(safety_decision, dict)
                            and safety_decision.get("decision") == "require_confirmation"
                        ):
                            print(
                                f"⚠️ Safety confirmation required: {safety_decision.get('explanation')}"
                            )
                            print("✅ Auto-acknowledging safety check")

                    result = self.execute_computer_action(fc)
                    results.append(result)

                function_response_parts = self.build_function_response_parts(
                    function_calls, results
                )
                self.contents.append(
                    Content(role="user", parts=function_response_parts)
                )

            except Exception as e:
                print(f"❌ Error during task execution: {e}")
                raise

        if iterations >= max_iterations:
            print(f"⚠️ Task execution stopped after {max_iterations} iterations")

        for content in reversed(self.contents):
            if content.role == "model" and content.parts:
                text_parts = [
                    p.text
                    for p in content.parts
                    if p.text and not re.fullmatch(r"[\s\d]*", p.text)
                ]
                if text_parts:
                    return " ".join(text_parts).strip()

        return "Task execution completed (no final message)"
```


#### Step 3: Create the Main Script

```python Python -wcn -f main.py
import sys
import time

from helpers import STEEL_API_KEY, GEMINI_API_KEY, TASK
from agent import Agent


def main():
    print("🚀 Steel + Gemini Computer Use Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print(
            "⚠️ WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
        )
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        sys.exit(1)

    if GEMINI_API_KEY == "your-gemini-api-key-here":
        print(
            "⚠️ WARNING: Please replace 'your-gemini-api-key-here' with your actual Gemini API key"
        )
        print("   Get your API key at: https://aistudio.google.com/apikey")
        sys.exit(1)

    print("\nStarting Steel session...")
    agent = Agent()

    try:
        agent.initialize()
        print("✅ Steel session started!")

        start_time = time.time()
        result = agent.execute_task(TASK, True, 50)
        duration = f"{(time.time() - start_time):.1f}"

        print("\n" + "=" * 60)
        print("🎉 TASK EXECUTION COMPLETED")
        print("=" * 60)
        print(f"⏱️  Duration: {duration} seconds")
        print(f"🎯 Task: {TASK}")
        print(f"📋 Result:\n{result}")
        print("=" * 60)

    except Exception as e:
        print(f"❌ Failed to run: {e}")
        raise

    finally:
        agent.cleanup()


if __name__ == "__main__":
    main()
```


#### Running Your Agent

Execute your script to start an interactive AI browser session:

```bash Terminal -wc
python main.py
```

You will see the session URL printed in the console. You can view the live browser session by opening this URL in your web browser.

The agent will execute the task defined in the `TASK` environment variable or the default task. You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Search for the latest news on artificial intelligence"
python main.py
```


#### Understanding Gemini's Coordinate System

Gemini's Computer Use model uses a normalized coordinate system where both X and Y coordinates range from 0 to 1000. The agent automatically converts these to actual pixel coordinates based on the viewport size (1440x900 by default, matching Google's recommended resolution for Computer Use).

#### Next Steps

*   Explore the [Steel API documentation](/overview) for more advanced features

*   Check out the [Gemini Computer Use documentation](https://ai.google.dev/gemini-api/docs/computer-use) for more information about the model

*   Add additional features like session recording or multi-session management





# Quickstart (Typescript)
URL: /integrations/gemini-computer-use/quickstart-ts

---
title: Quickstart (Typescript)
sidebarTitle: Quickstart (Typescript)
description: How to use Gemini Computer Use with Steel
llm: true
---

This guide will walk you through how to use Google's `gemini-3-flash-preview` model (with built-in computer use) and Steel's Computer API to create AI agents that can navigate the web.

Gemini's Computer Use model uses a normalized coordinate system (0-1000) and provides built-in actions for browser control, making it straightforward to integrate with Steel.

#### Prerequisites

*   Node.js 20+

*   A Steel API key ([sign up here](https://steel.dev/))

*   A Gemini API key ([get one here](https://aistudio.google.com/apikey))


#### Step 1: Setup and Helper Functions

First, create a project directory and install the required packages:

```bash Terminal -wc
# Create a project directory
mkdir steel-gemini-computer-use
cd steel-gemini-computer-use

# Initialize package.json
npm init -y

# Install required packages
npm install steel-sdk @google/genai dotenv
npm install -D @types/node typescript ts-node
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions, constants, and type definitions:

```typescript Typescript -wcn -f helpers.ts
import * as dotenv from "dotenv";
import { Steel } from "steel-sdk";
import {
  GoogleGenAI,
  FunctionResponse,
  Environment,
  FinishReason,
} from "@google/genai";
import type {
  Content,
  Part,
  FunctionCall,
  Tool,
  GenerateContentConfig,
  GenerateContentResponse,
  Candidate,
} from "@google/genai";

dotenv.config();

export const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "your-gemini-api-key-here";
export const TASK = process.env.TASK || "Go to Steel.dev and find the latest news";

export const MAX_COORDINATE = 1000;

export function formatToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

export const BROWSER_SYSTEM_PROMPT = `<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Chromium is already open; interact only through computer use actions (mouse, keyboard, scroll, screenshots).
  - Today's date is ${formatToday()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - When viewing pages, zoom out or scroll so all relevant content is visible.
  - When typing into any input:
    * Clear it first with Ctrl+A, then Delete.
    * After submitting (pressing Enter or clicking a button), wait for the page to load.
  - Computer tool calls are slow; batch related actions into a single call whenever possible.
  - You may act on the user's behalf on sites where they are already authenticated.
  - Assume any required authentication/Auth Contexts are already configured before the task starts.
  - If the first screenshot is black:
    * Click near the center of the screen.
    * Take another screenshot.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask the user clarifying questions; instead, make reasonable assumptions and proceed.
  - For complex tasks, quickly plan a short, ordered sequence of steps before acting.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Keep your final response concise and focused on fulfilling the task (e.g., a brief summary of findings or results).
  </TASK_EXECUTION>`;

export type Coordinates = [number, number];

export interface ActionResult {
  screenshotBase64: string;
  url?: string;
}

export { Steel, GoogleGenAI, FunctionResponse, Environment, FinishReason };
export type {
  Content,
  Part,
  FunctionCall,
  Tool,
  GenerateContentConfig,
  Candidate,
};
```


#### Step 2: Create the Agent Class

```typescript Typescript -wcn -f agent.ts
import {
  Steel,
  GoogleGenAI,
  FunctionResponse,
  Environment,
  FinishReason,
  STEEL_API_KEY,
  GEMINI_API_KEY,
  MAX_COORDINATE,
  BROWSER_SYSTEM_PROMPT,
} from "./helpers";
import type {
  Content,
  Part,
  FunctionCall,
  Tool,
  GenerateContentConfig,
  Candidate,
  Coordinates,
  ActionResult,
} from "./helpers";

export class Agent {
  private client: GoogleGenAI;
  private steel: Steel;
  private model: string;
  private session: Steel.Session | null = null;
  private contents: Content[];
  private tools: Tool[];
  private config: GenerateContentConfig;
  private viewportWidth: number;
  private viewportHeight: number;
  private currentUrl: string;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    this.steel = new Steel({ steelAPIKey: STEEL_API_KEY });
    this.model = "gemini-3-flash-preview";
    this.contents = [];
    this.currentUrl = "about:blank";
    this.viewportWidth = 1440;
    this.viewportHeight = 900;
    this.tools = [
      {
        computerUse: {
          environment: Environment.ENVIRONMENT_BROWSER,
        },
      },
    ];
    this.config = {
      tools: this.tools,
    };
  }

  private denormalizeX(x: number): number {
    return Math.round((x / MAX_COORDINATE) * this.viewportWidth);
  }

  private denormalizeY(y: number): number {
    return Math.round((y / MAX_COORDINATE) * this.viewportHeight);
  }

  private center(): Coordinates {
    return [
      Math.floor(this.viewportWidth / 2),
      Math.floor(this.viewportHeight / 2),
    ];
  }

  private splitKeys(k?: string): string[] {
    return k
      ? k
          .split("+")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  private normalizeKey(key: string): string {
    if (!key) return key;
    const k = key.trim();
    const upper = k.toUpperCase();
    const synonyms: Record<string, string> = {
      ENTER: "Enter",
      RETURN: "Enter",
      ESC: "Escape",
      ESCAPE: "Escape",
      TAB: "Tab",
      BACKSPACE: "Backspace",
      BKSP: "Backspace",
      DELETE: "Delete",
      DEL: "Delete",
      SPACE: "Space",
      CTRL: "Control",
      CONTROL: "Control",
      ALT: "Alt",
      SHIFT: "Shift",
      META: "Meta",
      SUPER: "Meta",
      CMD: "Meta",
      COMMAND: "Meta",
      UP: "ArrowUp",
      DOWN: "ArrowDown",
      LEFT: "ArrowLeft",
      RIGHT: "ArrowRight",
      ARROWUP: "ArrowUp",
      ARROWDOWN: "ArrowDown",
      ARROWLEFT: "ArrowLeft",
      ARROWRIGHT: "ArrowRight",
      HOME: "Home",
      END: "End",
      PAGEUP: "PageUp",
      PAGEDOWN: "PageDown",
      INSERT: "Insert",
    };
    if (upper in synonyms) return synonyms[upper];
    if (upper.startsWith("F") && /^\d+$/.test(upper.slice(1))) {
      return "F" + upper.slice(1);
    }
    return k;
  }

  private normalizeKeys(keys: string[]): string[] {
    return keys.map((k) => this.normalizeKey(k));
  }

  async initialize(): Promise<void> {
    this.session = await this.steel.sessions.create({
      dimensions: { width: this.viewportWidth, height: this.viewportHeight },
      blockAds: true,
      timeout: 900000,
    });
    console.log("Steel Session created successfully!");
    console.log(`View live session at: ${this.session.sessionViewerUrl}`);
  }

  async cleanup(): Promise<void> {
    if (this.session) {
      console.log("Releasing Steel session...");
      await this.steel.sessions.release(this.session.id);
      console.log(
        `Session completed. View replay at ${this.session.sessionViewerUrl}`
      );
      this.session = null;
    }
  }

  private async takeScreenshot(): Promise<string> {
    const resp: any = await this.steel.sessions.computer(this.session!.id, {
      action: "take_screenshot",
    });
    const img = resp?.base64_image;
    if (!img) throw new Error("No screenshot returned from Steel");
    return img;
  }

  private async executeComputerAction(
    functionCall: FunctionCall
  ): Promise<ActionResult> {
    const name = functionCall.name ?? "";
    const args = (functionCall.args ?? {}) as Record<string, unknown>;

    switch (name) {
      case "open_web_browser": {
        const screenshot = await this.takeScreenshot();
        return { screenshotBase64: screenshot, url: this.currentUrl };
      }

      case "click_at": {
        const x = this.denormalizeX(args.x as number);
        const y = this.denormalizeY(args.y as number);
        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "click_mouse",
          button: "left",
          coordinates: [x, y],
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "hover_at": {
        const x = this.denormalizeX(args.x as number);
        const y = this.denormalizeY(args.y as number);
        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "move_mouse",
          coordinates: [x, y],
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "type_text_at": {
        const x = this.denormalizeX(args.x as number);
        const y = this.denormalizeY(args.y as number);
        const text = args.text as string;
        const pressEnter = args.press_enter !== false;
        const clearBeforeTyping = args.clear_before_typing !== false;

        await this.steel.sessions.computer(this.session!.id, {
          action: "click_mouse",
          button: "left",
          coordinates: [x, y],
        });

        if (clearBeforeTyping) {
          await this.steel.sessions.computer(this.session!.id, {
            action: "press_key",
            keys: ["Control", "a"],
          });
          await this.steel.sessions.computer(this.session!.id, {
            action: "press_key",
            keys: ["Backspace"],
          });
        }

        await this.steel.sessions.computer(this.session!.id, {
          action: "type_text",
          text: text,
        });

        if (pressEnter) {
          await this.steel.sessions.computer(this.session!.id, {
            action: "press_key",
            keys: ["Enter"],
          });
        }

        await this.steel.sessions.computer(this.session!.id, {
          action: "wait",
          duration: 1,
        });

        const screenshot = await this.takeScreenshot();
        return { screenshotBase64: screenshot, url: this.currentUrl };
      }

      case "scroll_document": {
        const direction = args.direction as string;
        let keys: string[];

        if (direction === "down") {
          keys = ["PageDown"];
        } else if (direction === "up") {
          keys = ["PageUp"];
        } else if (direction === "left" || direction === "right") {
          const [cx, cy] = this.center();
          const delta = direction === "left" ? -400 : 400;
          const resp: any = await this.steel.sessions.computer(this.session!.id, {
            action: "scroll",
            coordinates: [cx, cy],
            delta_x: delta,
            delta_y: 0,
            screenshot: true,
          });
          return {
            screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
            url: this.currentUrl,
          };
        } else {
          keys = ["PageDown"];
        }

        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: keys,
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "scroll_at": {
        const x = this.denormalizeX(args.x as number);
        const y = this.denormalizeY(args.y as number);
        const direction = args.direction as string;
        const magnitude = this.denormalizeY((args.magnitude as number) ?? 800);

        let deltaX = 0;
        let deltaY = 0;

        if (direction === "down") deltaY = magnitude;
        else if (direction === "up") deltaY = -magnitude;
        else if (direction === "right") deltaX = magnitude;
        else if (direction === "left") deltaX = -magnitude;

        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "scroll",
          coordinates: [x, y],
          delta_x: deltaX,
          delta_y: deltaY,
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "wait_5_seconds": {
        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "wait",
          duration: 5,
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "go_back": {
        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Alt", "ArrowLeft"],
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "go_forward": {
        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Alt", "ArrowRight"],
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "search": {
        await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Control", "l"],
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "type_text",
          text: "https://www.google.com",
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Enter"],
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "wait",
          duration: 2,
        });
        this.currentUrl = "https://www.google.com";
        const screenshot = await this.takeScreenshot();
        return { screenshotBase64: screenshot, url: this.currentUrl };
      }

      case "navigate": {
        let url = args.url as string;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          url = "https://" + url;
        }

        await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Control", "l"],
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "type_text",
          text: url,
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: ["Enter"],
        });
        await this.steel.sessions.computer(this.session!.id, {
          action: "wait",
          duration: 2,
        });

        this.currentUrl = url;
        const screenshot = await this.takeScreenshot();
        return { screenshotBase64: screenshot, url: this.currentUrl };
      }

      case "key_combination": {
        const keysStr = args.keys as string;
        const normalizedKeys = this.normalizeKeys(this.splitKeys(keysStr));

        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "press_key",
          keys: normalizedKeys,
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      case "drag_and_drop": {
        const startX = this.denormalizeX(args.x as number);
        const startY = this.denormalizeY(args.y as number);
        const endX = this.denormalizeX(args.destination_x as number);
        const endY = this.denormalizeY(args.destination_y as number);

        const resp: any = await this.steel.sessions.computer(this.session!.id, {
          action: "drag_mouse",
          path: [
            [startX, startY],
            [endX, endY],
          ],
          screenshot: true,
        });
        return {
          screenshotBase64: resp?.base64_image || (await this.takeScreenshot()),
          url: this.currentUrl,
        };
      }

      default: {
        console.log(`Unknown action: ${name}, taking screenshot`);
        const screenshot = await this.takeScreenshot();
        return { screenshotBase64: screenshot, url: this.currentUrl };
      }
    }
  }

  private extractFunctionCalls(candidate: Candidate): FunctionCall[] {
    const functionCalls: FunctionCall[] = [];
    if (!candidate.content?.parts) return functionCalls;

    for (const part of candidate.content.parts) {
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
      }
    }
    return functionCalls;
  }

  private extractText(candidate: Candidate): string {
    if (!candidate.content?.parts) return "";
    const texts: string[] = [];
    for (const part of candidate.content.parts) {
      // Gemini 3 Flash occasionally emits stray digit/whitespace-only text
      // parts (e.g. "0", "00") alongside the real response. Skip them.
      if (part.text && !/^[\s\d]*$/.test(part.text)) {
        texts.push(part.text);
      }
    }
    return texts.join(" ").trim();
  }

  private buildFunctionResponseParts(
    functionCalls: FunctionCall[],
    results: ActionResult[]
  ): Part[] {
    const parts: Part[] = [];

    for (let i = 0; i < functionCalls.length; i++) {
      const fc = functionCalls[i];
      const result = results[i];

      const functionResponse: FunctionResponse = {
        name: fc.name ?? "",
        response: { url: result.url ?? this.currentUrl },
      };

      parts.push({ functionResponse });
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: result.screenshotBase64,
        },
      });
    }

    return parts;
  }

  async executeTask(
    task: string,
    printSteps: boolean = true,
    maxIterations: number = 50
  ): Promise<string> {
    this.contents = [
      {
        role: "user",
        parts: [{ text: BROWSER_SYSTEM_PROMPT }, { text: task }],
      },
    ];

    let iterations = 0;
    let consecutiveNoActions = 0;

    console.log(`🎯 Executing task: ${task}`);
    console.log("=".repeat(60));

    while (iterations < maxIterations) {
      iterations++;

      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: this.contents,
          config: this.config,
        });

        if (!response.candidates || response.candidates.length === 0) {
          console.log("❌ No candidates in response");
          break;
        }

        const candidate = response.candidates[0];

        if (candidate.content) {
          this.contents.push(candidate.content);
        }

        const reasoning = this.extractText(candidate);
        const functionCalls = this.extractFunctionCalls(candidate);

        if (
          !functionCalls.length &&
          !reasoning &&
          candidate.finishReason === FinishReason.MALFORMED_FUNCTION_CALL
        ) {
          console.log("⚠️ Malformed function call, retrying...");
          continue;
        }

        if (!functionCalls.length) {
          if (reasoning) {
            if (printSteps) {
              console.log(`\n💬 ${reasoning}`);
            }
            console.log("✅ Task complete - model provided final response");
            break;
          }

          consecutiveNoActions++;
          if (consecutiveNoActions >= 3) {
            console.log(
              "⚠️ No actions for 3 consecutive iterations - stopping"
            );
            break;
          }
          continue;
        }

        consecutiveNoActions = 0;

        if (printSteps && reasoning) {
          console.log(`\n💭 ${reasoning}`);
        }

        const results: ActionResult[] = [];

        for (const fc of functionCalls) {
          const actionName = fc.name ?? "unknown";
          const actionArgs = fc.args ?? {};

          if (printSteps) {
            console.log(`🔧 ${actionName}(${JSON.stringify(actionArgs)})`);
          }

          const result = await this.executeComputerAction(fc);
          results.push(result);
        }

        const functionResponseParts = this.buildFunctionResponseParts(
          functionCalls,
          results
        );

        this.contents.push({
          role: "user",
          parts: functionResponseParts,
        });
      } catch (error) {
        console.error(`❌ Error during task execution: ${error}`);
        throw error;
      }
    }

    if (iterations >= maxIterations) {
      console.warn(
        `⚠️ Task execution stopped after ${maxIterations} iterations`
      );
    }

    for (let i = this.contents.length - 1; i >= 0; i--) {
      const content = this.contents[i];
      if (content.role === "model") {
        const text = content.parts
          ?.filter((p) => p.text && !/^[\s\d]*$/.test(p.text))
          .map((p) => p.text)
          .join(" ")
          .trim();
        if (text) {
          return text;
        }
      }
    }

    return "Task execution completed (no final message)";
  }
}
```


#### Step 3: Create the Main Script

```typescript Typescript -wcn -f main.ts
import { Agent } from "./agent";
import { STEEL_API_KEY, GEMINI_API_KEY, TASK } from "./helpers";

async function main(): Promise<void> {
  console.log("🚀 Steel + Gemini Computer Use Assistant");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn(
      "⚠️ WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
    );
    console.warn(
      "   Get your API key at: https://app.steel.dev/settings/api-keys"
    );
    throw new Error("Set STEEL_API_KEY");
  }

  if (GEMINI_API_KEY === "your-gemini-api-key-here") {
    console.warn(
      "⚠️ WARNING: Please replace 'your-gemini-api-key-here' with your actual Gemini API key"
    );
    console.warn("   Get your API key at: https://aistudio.google.com/apikey");
    throw new Error("Set GEMINI_API_KEY");
  }

  console.log("\nStarting Steel session...");
  const agent = new Agent();

  try {
    await agent.initialize();
    console.log("✅ Steel session started!");

    const startTime = Date.now();
    const result = await agent.executeTask(TASK, true, 50);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 TASK EXECUTION COMPLETED");
    console.log("=".repeat(60));
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log(`🎯 Task: ${TASK}`);
    console.log(`📋 Result:\n${result}`);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`❌ Failed to run: ${error}`);
    throw error;
  } finally {
    await agent.cleanup();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Task execution failed:", error);
    process.exit(1);
  });
```


#### Running Your Agent

Execute your script to start an interactive AI browser session:

```bash Terminal -wc
npx ts-node main.ts
```

The agent will execute the task defined in the `TASK` environment variable or the default task. You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Research the latest developments in AI"
npx ts-node main.ts
```

You'll see each action the agent takes displayed in the console, and you can view the live browser session by opening the session URL in your web browser.

#### Understanding Gemini's Coordinate System

Gemini's Computer Use model uses a normalized coordinate system where both X and Y coordinates range from 0 to 1000. The agent automatically converts these to actual pixel coordinates based on the viewport size (1440x900 by default, matching Google's recommended resolution for Computer Use).

#### Next Steps

*   Explore the [Steel API documentation](/overview) for more advanced features

*   Check out the [Gemini Computer Use documentation](https://ai.google.dev/gemini-api/docs/computer-use) for more information about the model

*   Add additional features like session recording or multi-session management





# Overview
URL: /integrations/crewai/integrations-overview

---
title: Overview
sidebarTitle: Overview
description: CrewAI is a lean, lightning-fast Python framework for orchestrating autonomous, multi-agent systems, built from scratch and independent of other agent frameworks.
llm: true
---
#### Overview

The CrewAI integration connects Steel’s reliable cloud browsers with CrewAI’s **Crews** (autonomous agent teams) and **Flows** (event-driven orchestration). This lets you:

*   Launch & control Steel browser sessions from CrewAI agents and tasks

*   Automate complex web workflows (search, navigate, form-fill, extract, validate) with agent collaboration

*   Mix autonomy (Crews) with precise control (Flows) for production-grade pipelines

*   Share memory/state across steps and return structured outputs (JSON/typed)

*   Add human-in-the-loop checkpoints for sensitive actions and final reviews


Together, CrewAI + Steel deliver scalable, enterprise-ready web automation with proxies, sandboxed isolation, and anti-bot options.

#### Requirements

*   **Steel API Key**: Active Steel subscription to create/manage browser sessions

*   **LLM API Key(s)**: e.g., OpenAI (or your preferred provider/local runtime)

*   **Python**: 3.10–3.13 recommended

*   **Optional Tools**: Search (e.g., [Serper.dev](http://serper.dev/)), vector stores, and custom tools as needed


#### Documentation

[Quickstart Guide](/integrations/crewai/quickstart) → Build your first Crew (or Flow) that drives a Steel browser session end-to-end.

#### Additional Resources

*   [CrewAI Documentation](https://docs.crewai.com/) – Concepts for Crews, Flows, agents, and processes

*   [CrewAI Examples Repo](https://github.com/crewAIInc/crewAI-examples) – Real-world starter crews (trip planner, stock analysis, job posts)

*   [Steel Sessions API Reference](/api-reference) – Programmatically manage Steel browser sessions

*   [Community Discord](https://discord.gg/steel-dev) – Share recipes and get help


# Quickstart
URL: /integrations/crewai/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: This guide walks you through wiring a CrewAI multi-agent workflow to Steel so your agents can research the web and produce a structured report.
llm: true
---

#### Prerequisites

Make sure you have:

*   Python **3.10+** (CrewAI 1.x requires `<3.14`)

*   **Steel API key** (get one at [app.steel.dev](http://app.steel.dev/))

*   **OpenAI API key** (this starter pins the agent LLM to `gpt-5-nano`)


#### Step 1: Project setup

Create and activate a virtual environment, then install dependencies:

```package-install python
"crewai[tools]>=1.14,<2" "openai>=2,<3" "pydantic>=2.11,<3" steel-sdk python-dotenv
```


Create a `.env` file with your keys and a default task:

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
OPENAI_API_KEY=your-openai-api-key-here
TASK=Research AI LLMs and summarize key developments
```


#### Step 2: Define a Steel-powered web tool for CrewAI

Create a minimal CrewAI `BaseTool` that calls Steel’s scraping API. This tool will let agents fetch page content (e.g., as Markdown) during a task

```python Python -wcn -f main.py
import os
from typing import List, Optional, Type
from pydantic import BaseModel, Field, ConfigDict, PrivateAttr

from crewai.tools import BaseTool, EnvVar
from steel import Steel

class SteelScrapeWebsiteToolSchema(BaseModel):
    url: str = Field(description="Website URL to scrape")

class SteelScrapeWebsiteTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True, validate_assignment=True, frozen=False)
    name: str = "Steel web scrape tool"
    description: str = "Scrape webpages using Steel and return the contents"
    args_schema: Type[BaseModel] = SteelScrapeWebsiteToolSchema

    api_key: Optional[str] = None
    formats: Optional[List[str]] = None
    proxy: Optional[bool] = None

    _steel: Optional[Steel] = PrivateAttr(None)

    # For CrewAI’s packaging & env var hints
    package_dependencies: List[str] = ["steel-sdk"]
    env_vars: List[EnvVar] = [
        EnvVar(name="STEEL_API_KEY", description="API key for Steel services", required=True),
    ]

    def __init__(self, api_key: Optional[str] = None, formats: Optional[List[str]] = None,
                 proxy: Optional[bool] = None, **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key or os.getenv("STEEL_API_KEY")
        if not self.api_key:
            raise EnvironmentError("STEEL_API_KEY environment variable or api_key is required")

        self._steel = Steel(steel_api_key=self.api_key)
        self.formats = formats or ["markdown"]  # return content as Markdown by default
        self.proxy = proxy

    def _run(self, url: str):
        if not self._steel:
            raise RuntimeError("Steel not properly initialized")
        # You can set region/proxy based on your needs
        return self._steel.scrape(url=url, use_proxy=self.proxy, format=self.formats, region="iad")

```


#### Step 3: Define your Crew (agents + tasks)

Wire the tool into a **researcher** and a **reporting\_analyst** agent, then compose two tasks into a sequential process.

```python Python -wcn -f main.py
import warnings
from datetime import datetime
from textwrap import dedent
from typing import List
from dotenv import load_dotenv

from crewai import Agent, Process, Task
from crewai import Crew as CrewAI
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.project import CrewBase, agent, crew, task

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")
load_dotenv()

TASK = os.getenv("TASK") or "Research AI LLMs and summarize key developments"

@CrewBase
class Crew():
    """Steel + CrewAI example crew"""
    agents: List[BaseAgent]
    tasks: List[Task]

    @agent
    def researcher(self) -> Agent:
        return Agent(
            role="Instruction-Following Web Researcher",
            goal="Understand and execute: {task}. Find, verify, and extract the most relevant information using the web.",
            backstory=(
                "You specialize in decomposing and executing complex instructions like '{task}', "
                "using web research, verification, and synthesis to produce precise, actionable findings."
            ),
            tools=[SteelScrapeWebsiteTool()],
            llm="gpt-5-nano",
            verbose=True,
        )

    @agent
    def reporting_analyst(self) -> Agent:
        return Agent(
            role="Instruction-Following Reporting Analyst",
            goal="Transform research outputs into a clear, complete report that fulfills: {task}",
            backstory=(
                "You convert research into exhaustive, well-structured reports that directly address "
                "the original instruction '{task}', ensuring completeness and clarity."
            ),
            tools=[SteelScrapeWebsiteTool()],
            llm="gpt-5-nano",
            verbose=True,
        )

    @task
    def research_task(self) -> Task:
        return Task(
            description=dedent("""
                Interpret and execute the following instruction: {task}
                Use the web as needed. Cite and include key sources.
                Consider the current year: {current_year}.
            """),
            expected_output="A structured set of findings and sources that directly satisfy the instruction: {task}",
            agent=self.researcher(),
        )

    @task
    def reporting_task(self) -> Task:
        return Task(
            description=dedent("""
                Review the research context and produce a complete report that fulfills the instruction.
                Ensure completeness, accuracy, and clear structure. Include citations.
            """),
            expected_output=(
                "A comprehensive markdown report that satisfies the instruction: {task}. "
                "Formatted as markdown without '```'"
            ),
            agent=self.reporting_analyst(),
        )

    @crew
    def crew(self) -> CrewAI:
        """Creates the sequential crew pipeline"""
        return CrewAI(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )

```


#### Step 4: Run your crew

Add a simple `main()` to validate API keys, pass inputs, and execute.

```python Python -wcn -f main.py
def main():
    print("🚀 Steel + CrewAI Starter")
    print("=" * 60)

    if not os.getenv("STEEL_API_KEY") or os.getenv("STEEL_API_KEY") == "your-steel-api-key-here":
        print("⚠️  WARNING: Please set STEEL_API_KEY in your .env")
        print("   Get your key at: https://app.steel.dev/settings/api-keys")
        return

    inputs = {
        "task": TASK,
        "current_year": str(datetime.now().year),
    }

    try:
        print("Running crew...")
        Crew().crew().kickoff(inputs=inputs)
        print("\n✅ Done. (If your task wrote to a file, check your project folder.)")
    except Exception as e:
        print(f"❌ Error while running the crew: {e}")

if __name__ == "__main__":
    main()

```


#### Run it:

The **researcher** will use the Steel tool to fetch web content; the **reporting\_analyst** will turn the context into a final report.

#### Full Example

Complete `main.py` you can paste and run:

```python Python -wcn -f main.py
import os
import warnings
from datetime import datetime
from textwrap import dedent
from typing import List, Optional, Type

from crewai import Agent, Process, Task
from crewai import Crew as CrewAI
from crewai.agents.agent_builder.base_agent import BaseAgent
from crewai.project import CrewBase, agent, crew, task
from crewai.tools import BaseTool, EnvVar
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr
from steel import Steel

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")
load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv('STEEL_API_KEY') or "your-steel-api-key-here"

# Replace with your own task
TASK = os.getenv('TASK') or 'Research AI LLMs and summarize key developments'

class SteelScrapeWebsiteToolSchema(BaseModel):
    url: str = Field(description="Website URL")

class SteelScrapeWebsiteTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True, validate_assignment=True, frozen=False)
    name: str = "Steel web scrape tool"
    description: str = "Scrape webpages using Steel and return the contents"
    args_schema: Type[BaseModel] = SteelScrapeWebsiteToolSchema
    api_key: Optional[str] = None
    formats: Optional[List[str]] = None
    proxy: Optional[bool] = None

    _steel: Optional[Steel] = PrivateAttr(None)
    package_dependencies: List[str] = ["steel-sdk"]
    env_vars: List[EnvVar] = [
        EnvVar(name="STEEL_API_KEY", description="API key for Steel services", required=True),
    ]

    def __init__(self, api_key: Optional[str] = None, formats: Optional[List[str]] = None,
                 proxy: Optional[bool] = None, **kwargs):
        super().__init__(**kwargs)
        self.api_key = api_key or os.getenv("STEEL_API_KEY")
        if not self.api_key:
            raise EnvironmentError("STEEL_API_KEY environment variable or api_key is required")

        self._steel = Steel(steel_api_key=self.api_key)
        self.formats = formats or ["markdown"]
        self.proxy = proxy

    def _run(self, url: str):
        if not self._steel:
            raise RuntimeError("Steel not properly initialized")
        return self._steel.scrape(url=url, use_proxy=self.proxy, format=self.formats, region="iad")

@CrewBase
class Crew():
    """Crew crew"""
    agents: List[BaseAgent]
    tasks: List[Task]

    @agent
    def researcher(self) -> Agent:
        return Agent(
            role="Instruction-Following Web Researcher",
            goal="Understand and execute: {task}. Find, verify, and extract the most relevant information using the web.",
            backstory=(
                "You specialize in decomposing and executing complex instructions like '{task}', "
                "using web research, verification, and synthesis to produce precise, actionable findings."
            ),
            tools=[SteelScrapeWebsiteTool()],
            llm="gpt-5-nano",
            verbose=True
        )

    @agent
    def reporting_analyst(self) -> Agent:
        return Agent(
            role="Instruction-Following Reporting Analyst",
            goal="Transform research outputs into a clear, complete report that fulfills: {task}",
            backstory=(
                "You convert research into exhaustive, well-structured reports that directly address "
                "the original instruction '{task}', ensuring completeness and clarity."
            ),
            tools=[SteelScrapeWebsiteTool()],
            llm="gpt-5-nano",
            verbose=True
        )

    @task
    def research_task(self) -> Task:
        return Task(
            description=dedent("""
                Interpret and execute the following instruction: {task}
                Use the web as needed. Cite and include key sources.
                Consider the current year: {current_year}.
            """),
            expected_output="A structured set of findings and sources that directly satisfy the instruction: {task}",
            agent=self.researcher()
        )

    @task
    def reporting_task(self) -> Task:
        return Task(
            description=dedent("""
                Review the research context and produce a complete report that fulfills the instruction.
                Ensure completeness, accuracy, and clear structure. Include citations.
            """),
            expected_output="A comprehensive markdown report that satisfies the instruction: {task}. Formatted as markdown without '```'",
            agent=self.reporting_analyst(),
        )

    @crew
    def crew(self) -> CrewAI:
        """Creates the Crew crew"""
        return CrewAI(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )

def main():
    print("🚀 Steel + CrewAI Starter")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    inputs = {
        'task': TASK,
        'current_year': str(datetime.now().year)
    }

    try:
        print("Running crew...")
        Crew().crew().kickoff(inputs=inputs)
        print("\n✅ Crew finished.")
    except Exception as e:
        print(f"❌ An error occurred while running the crew: {e}")

if __name__ == "__main__":
    main()

```


#### Customizing your crew’s task

Try changing the `TASK` to drive different behaviors:

```env ENV -wcn -f .env
TASK = "Visit https://docs.steel.dev and summarize the Sessions API lifecycle with citations."
# or
TASK = "Find the latest research trends in open-weights LLMs and produce a bullet summary with 5 sources."
# or
TASK = "Compare two AI agent frameworks and write a short pros/cons table with links."
```


#### Next steps

*   Session Lifecycles: [https://docs.steel.dev/overview/sessions-api/session-lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle)

*   Steel Sessions API: [https://docs.steel.dev/overview/sessions-api/overview](https://docs.steel.dev/overview/sessions-api/overview)

*   Steel Python SDK: [https://github.com/steel-dev/steel-python](https://github.com/steel-dev/steel-python)

*   CrewAI Docs: [https://docs.crewai.com](https://docs.crewai.com/)


# Quickstart
URL: /integrations/magnitude/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: This guide shows how to use Magnitude with Steel to create an AI browser agent that visits the Steel leaderboard Github repo, extracts the details behind the latest commit, and if associated with a pull request, it will summarize the details.
llm: true
---

Scroll to the bottom to see a full example!

### Requirements

*   **Anthropic API Key**

*   **Steel API Key**

*   **Node.js 20+**


### Step 1: Project Setup

Create a new TypeScript project and basic script:

```bash Terminal -wc
mkdir steel-magnitude && \
cd steel-magnitude && \
npm init -y && \
npm install -D typescript @types/node ts-node && \
npx tsc --init && \
npm pkg set scripts.start="ts-node index.ts" && \
touch index.ts .env
```


### Step 2: Install Dependencies

```package-install
steel-sdk magnitude-core zod dotenv
```


### Step 3: Environment Variables

Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```


### Step 4: Initialize Steel & Magnitude

Set up Steel, load env vars, and prepare to start the Magnitude agent.

```typescript Typescript -wcn -f index.ts
import * as dotenv from "dotenv";
import { Steel } from "steel-sdk";
import { startBrowserAgent } from "magnitude-core";
import { z } from "zod";

dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "your-anthropic-api-key-here";

const client = new Steel({ steelAPIKey: STEEL_API_KEY });

```


### Step 5: Create a Steel Session & Start the Agent

Create a Steel session, then connect Magnitude via **CDP**. Turn on `narrate` for easy debugging.

```typescript Typescript -wcn -f index.ts
async function main() {
  console.log("🚀 Steel + Magnitude Node Starter");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn("⚠️  Please set STEEL_API_KEY in your .env");
    console.warn("    Get one at https://app.steel.dev/settings/api-keys");
    return;
  }

  if (ANTHROPIC_API_KEY === "your-anthropic-api-key-here") {
    console.warn("⚠️  Please set ANTHROPIC_API_KEY in your .env");
    console.warn("    Get one at https://console.anthropic.com/");
    return;
  }

  let session: any;
  let agent: any;

  try {
    console.log("\nCreating Steel session...");
    session = await client.sessions.create({
      // Optional knobs:
      // useProxy: true,
      // proxyUrl: 'http://user:pass@host:port',
      // solveCaptcha: true,
      // sessionTimeout: 1800000, // ms
      // userAgent: 'custom-ua'
    });

    console.log(`Steel session created!`);
    console.log(`View session at: ${session.sessionViewerUrl}`);

    agent = await startBrowserAgent({
      url: "https://github.com/steel-dev/leaderboard",
      narrate: true,
      llm: {
        provider: "anthropic",
        options: {
          model: "claude-sonnet-4-6",
          apiKey: process.env.ANTHROPIC_API_KEY,
        },
      },
      browser: {
        cdp: `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
      },
    });

    console.log("Connected to browser via Magnitude");
```


Use Magnitude’s `agent.extract` to pull structured data (user behind commit + commit itself) using a Zod schema.

```typescript Typescript -wcn -f index.ts
    console.log("Looking for commits");

    const mostRecentCommitter = await agent.extract(
      "Find the user with the most recent commit",
      z.object({
        user: z.string(),
        commit: z.string(),
      })
    );

    console.log("\n\x1b[1;92mMost recent committer:\x1b[0m");
    console.log(`${mostRecentCommitter.user} has the most recent commit`);

```


### Step 7: Perform Natural-Language Actions

Use `agent.act` to summarize the pull request (if there’s a pull request behind the commit).

```typescript Typescript -wcn -f index.ts
    console.log("\nLooking for pull request behind the most recent commit\x1b[0m");

    try {
      await agent.act(
        "Find the pull request behind the most recent commit if there is one"
      );
      console.log("Found pull request!");

      const pullRequest = await agent.extract(
        "What was added in this pull request?",
        z.object({
          summary: z.string(),
        })
      );
      console.log("Pull request found!");
      console.log(`${pullRequest.summary}`);
    } catch (error) {
      console.log("No pull request found or accessible");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("\nAutomation completed successfully!");
```


### Step 8: Clean Up

Stop the agent and release the Steel session.

```typescript Typescript -wcn -f index.ts
  } catch (error) {
    console.error("Error during automation:", error);
  } finally {
    if (agent) {
      console.log("Stopping Magnitude agent...");
      try {
        await agent.stop();
      } catch (error) {
        console.error("Error stopping agent:", error);
      }
    }

    if (session) {
      console.log("Releasing Steel session...");
      try {
        await client.sessions.release(session.id);
        console.log("Steel session released successfully");
      } catch (error) {
        console.error("Error releasing session:", error);
      }
    }
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
```


#### Run It

You’ll see a **session viewer URL** in your console, open it to watch the automation live.

### Full Example

Complete `index.ts` you can paste and run:

```typescript Typescript -wcn -f index.ts
/*
 * AI-powered browser automation using Magnitude with Steel browsers.
 * https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-magnitude-starter
 */

import * as dotenv from "dotenv";
import { Steel } from "steel-sdk";
import { z } from "zod";
import { startBrowserAgent } from "magnitude-core";

dotenv.config();

// Replace with your own API keys
const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "your-anthropic-api-key-here";

// Initialize Steel client with the API key from environment variables
const client = new Steel({ steelAPIKey: STEEL_API_KEY });

async function main() {
  console.log("🚀 Steel + Magnitude Node Starter");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key");
    console.warn("   Get your API key at: https://app.steel.dev/settings/api-keys");
    return;
  }

  if (ANTHROPIC_API_KEY === "your-anthropic-api-key-here") {
    console.warn("⚠️  WARNING: Please replace 'your-anthropic-api-key-here' with your actual Anthropic API key");
    console.warn("   Get your API key at: https://console.anthropic.com/");
    return;
  }

  let session: any;
  let agent: any;

  try {
    console.log("\nCreating Steel session...");
    session = await client.sessions.create({
      // Optional knobs:
      // useProxy: true,
      // proxyUrl: 'http://user:pass@host:port',
      // solveCaptcha: true,
      // sessionTimeout: 1800000, // ms
      // userAgent: 'custom-ua'
    });

    console.log(`Steel session created!`);
    console.log(`View session at: ${session.sessionViewerUrl}`);

    agent = await startBrowserAgent({
      url: "https://github.com/steel-dev/leaderboard",
      narrate: true,
      llm: {
        provider: "anthropic",
        options: {
          model: "claude-sonnet-4-6",
          apiKey: process.env.ANTHROPIC_API_KEY,
        },
      },
      browser: {
        cdp: `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
      },
    });

    console.log("Connected to browser via Magnitude");
    console.log("Looking for commits");

    const mostRecentCommitter = await agent.extract(
      "Find the user with the most recent commit",
      z.object({
        user: z.string(),
        commit: z.string(),
      })
    );

    console.log("Most recent committer:");
    console.log(`${mostRecentCommitter.user} has the most recent commit`);

    console.log("\nLooking for pull request behind the most recent commit\x1b[0m");

    try {
      await agent.act(
        "Find the pull request behind the most recent commit if there is one"
      );
      console.log("Found pull request!");

      const pullRequest = await agent.extract(
        "What was added in this pull request?",
        z.object({
          summary: z.string(),
        })
      );
      console.log("Pull request found!");
      console.log(`${pullRequest.summary}`);
    } catch (error) {
      console.log("No pull request found or accessible");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log("\nAutomation completed successfully!");
  } catch (error) {
    console.error("Error during automation:", error);
  } finally {
    if (agent) {
      console.log("Stopping Magnitude agent...");
      try {
        await agent.stop();
      } catch (error) {
        console.error("Error stopping agent:", error);
      }
    }

    if (session) {
      console.log("Releasing Steel session...");
      try {
        await client.sessions.release(session.id);
        console.log("Steel session released successfully");
      } catch (error) {
        console.error("Error releasing session:", error);
      }
    }
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

```


### Next Steps

*   **Magnitude Documentation**: [https://docs.magnitude.run/getting-started/introduction](https://docs.magnitude.run/getting-started/introduction)

*   **Session Lifecycles**: [https://docs.steel.dev/overview/sessions-api/session-lifecycle](/overview/sessions-api/session-lifecycle)

*   **Steel Sessions API**: [https://docs.steel.dev/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **Steel Node SDK**: [https://github.com/steel-dev/steel-node](https://github.com/steel-dev/steel-node)

*   **This Example on Github**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-magnitude-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-magnitude-starter)


# Quickstart
URL: /integrations/notte/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: This guide shows how to use Notte with Steel to run a simple task in a live cloud browser, then shut everything down safely.
llm: true
---

### Requirements
:::prerequisites
*   **Steel API key**

*   **Gemini API key**

*   **Python 3.11+**
:::

### Step 1: Project Setup and Install Dependencies

```package-install python
steel-sdk notte python-dotenv
```


### Step 2: Environment Variables

Create a `.env` file with your API keys and a default task:

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
GEMINI_API_KEY=your-gemini-api-key-here
TASK="Go to Wikipedia and search for machine learning"
```


### Step 3: Initialize Steel & Notte, then Connect via CDP

Set up Steel, load env vars, and prepare to start the Notte agent.

```python Python -wcn -f main.py
import os
import time
import asyncio
from dotenv import load_dotenv
from steel import Steel
import notte

load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or "your-gemini-api-key-here"

# Replace with your own task
TASK = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"
```


### Step 4: Run a Notte Agent Task

Create a Steel session, connect Notte via **CDP**, run your task, and print the result.

```python Python -wcn -f main.py
async def main():
    print("🚀 Steel + Notte Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    if GEMINI_API_KEY == "your-gemini-api-key-here":
        print("⚠️  WARNING: Please replace 'your-gemini-api-key-here' with your actual Gemini API key")
        print("   Get your API key at: https://console.cloud.google.com/apis/credentials")
        return

    print("\nStarting Steel browser session...")

    client = Steel(steel_api_key=STEEL_API_KEY)

    try:
        session = client.sessions.create()
        print("✅ Steel browser session started!")
        print(f"View live session at: {session.session_viewer_url}")

        print(
            f"\033[1;93mSteel Session created!\033[0m\n"
            f"View session at \033[1;37m{session.session_viewer_url}\033[0m\n"
        )

        cdp_url = f"{session.websocket_url}&apiKey={STEEL_API_KEY}"

        start_time = time.time()

        print(f"🎯 Executing task: {TASK}")
        print("=" * 60)

        try:
            with notte.Session(cdp_url=cdp_url) as notte_session:
                agent = notte.Agent(
                    session=notte_session,
                    max_steps=5,
                    reasoning_model="gemini/gemini-2.5-flash"
                )
                response = agent.run(task=TASK)

                duration = f"{(time.time() - start_time):.1f}"

                print("\n" + "=" * 60)
                print("🎉 TASK EXECUTION COMPLETED")
                print("=" * 60)
                print(f"⏱️  Duration: {duration} seconds")
                print(f"🎯 Task: {TASK}")
                if response:
                    print(f"📋 Result:\n{response.answer}")
                print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
        finally:
            if session:
                print("Releasing Steel session...")
                client.sessions.release(session.id)
                print(f"Session completed. View replay at {session.session_viewer_url}")
            print("Done!")

    except Exception as e:
        print(f"❌ Failed to start Steel browser: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")


if __name__ == "__main__":
    asyncio.run(main())
```


#### Run It

You’ll see a **session viewer URL** in your console, open it to watch the automation live.

### Full Example

Complete `main.py` you can paste and run:

```python Python -wc -f main.py
"""
AI-powered browser automation using notte-sdk with Steel browsers.
https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-notte-starter
"""

import os
import time
import asyncio
from dotenv import load_dotenv
from steel import Steel
import notte

load_dotenv()

# Replace with your own API keys
STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or "your-gemini-api-key-here"

# Replace with your own task
TASK = os.getenv("TASK") or "Go to Wikipedia and search for machine learning"

async def main():
    print("🚀 Steel + Notte Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key")
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        return

    if GEMINI_API_KEY == "your-gemini-api-key-here":
        print("⚠️  WARNING: Please replace 'your-gemini-api-key-here' with your actual Gemini API key")
        print("   Get your API key at: https://console.cloud.google.com/apis/credentials")
        return

    print("\nStarting Steel browser session...")

    client = Steel(steel_api_key=STEEL_API_KEY)

    try:
        session = client.sessions.create()
        print("✅ Steel browser session started!")
        print(f"View live session at: {session.session_viewer_url}")

        print(
            f"\033[1;93mSteel Session created!\033[0m\n"
            f"View session at \033[1;37m{session.session_viewer_url}\033[0m\n"
        )

        cdp_url = f"{session.websocket_url}&apiKey={STEEL_API_KEY}"

        start_time = time.time()

        print(f"🎯 Executing task: {TASK}")
        print("=" * 60)

        try:
            with notte.Session(cdp_url=cdp_url) as notte_session:
                agent = notte.Agent(
                    session=notte_session,
                    max_steps=5,
                    reasoning_model="gemini/gemini-2.5-flash"
                )
                response = agent.run(task=TASK)

                duration = f"{(time.time() - start_time):.1f}"

                print("\n" + "=" * 60)
                print("🎉 TASK EXECUTION COMPLETED")
                print("=" * 60)
                print(f"⏱️  Duration: {duration} seconds")
                print(f"🎯 Task: {TASK}")
                if response:
                    print(f"📋 Result:\n{response.answer}")
                print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
        finally:
            if session:
                print("Releasing Steel session...")
                client.sessions.release(session.id)
                print(f"Session completed. View replay at {session.session_viewer_url}")
            print("Done!")

    except Exception as e:
        print(f"❌ Failed to start Steel browser: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")


if __name__ == "__main__":
    asyncio.run(main())

```


### Next Steps
:::next-steps
- [Session Lifecycles](/sessions-api/session-lifecycle): Sessions Lifecycle

- [Steel Sessions API](/sessions-api/overview): Sessions API Overview

:::
- **Steel Python SDK**: [https://github.com/steel-dev/steel-python](https://github.com/steel-dev/steel-python)

- **Cookbook example**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-notte-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-notte-starter)

- **Notte Documentation:** [https://docs.notte.cc/intro/what-is-notte](https://docs.notte.cc/intro/what-is-notte)


# Quickstart (TypeScript)
URL: /integrations/openai-agents-sdk/quickstart-node

---
title: Quickstart (TypeScript)
sidebarTitle: Quickstart (TypeScript)
description: Build a browser agent with the OpenAI Agents SDK for TypeScript and Steel. The agent opens a Steel session, navigates and snapshots the page, optionally extracts structured rows, and returns a Zod-validated final report.
llm: true
---

Scroll to the bottom for the full example.

### Requirements

*   **Steel API key**

*   **OpenAI API key**

*   **Node.js 20+**

### Step 1: Project Setup

```bash Terminal -wc
mkdir steel-openai-agents && \
cd steel-openai-agents && \
npm init -y && \
npm install -D typescript @types/node ts-node && \
npx tsc --init && \
npm pkg set scripts.start="ts-node index.ts" && \
touch index.ts .env
```

### Step 2: Install Dependencies

```package-install
@openai/agents steel-sdk playwright zod dotenv
```

### Step 3: Environment Variables

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
OPENAI_API_KEY=your-openai-api-key-here
```

### Step 4: Define Steel tools

Each tool is a typed `tool()` with a Zod `parameters` schema. Browser state (the Steel session + Playwright page) lives in a closure so every tool call sees the same page.

:::callout
type: info
### Two Zod gotchas with OpenAI strict mode
The Agents SDK sends tool schemas in strict JSON Schema mode. Two things get rejected that otherwise look fine:

- **Use `.nullable()`, not `.optional()`.** Every property must be in `required`. `z.string().optional()` marks the field not-required and is rejected; `z.string().nullable()` keeps it required but lets the model pass `null`.
- **Skip `.url()` on tool params.** Zod emits `"format": "uri"` for `.url()`, and strict mode rejects `uri` (supported formats are `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uuid`). Use plain `z.string()` and validate inside `execute` if needed.
:::

```typescript Typescript -wcn -f index.ts
import * as dotenv from "dotenv";
import { Agent, run, tool } from "@openai/agents";
import { chromium, type Browser, type Page } from "playwright";
import Steel from "steel-sdk";
import { z } from "zod";

dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY!;
const steel = new Steel({ steelAPIKey: STEEL_API_KEY });

let session: Awaited<ReturnType<typeof steel.sessions.create>> | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

const openSession = tool({
  name: "open_session",
  description:
    "Open a Steel cloud browser session. Call exactly once, before anything else.",
  parameters: z.object({}),
  execute: async () => {
    session = await steel.sessions.create({});
    browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`
    );
    const ctx = browser.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.newPage());
    return { sessionId: session.id, liveViewUrl: session.sessionViewerUrl };
  },
});

const navigate = tool({
  name: "navigate",
  description: "Navigate the open session to a URL and wait for it to load.",
  // OpenAI strict JSON Schema rejects "uri" format, so use plain z.string() here.
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => {
    if (!page) throw new Error("open_session first.");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return { url: page.url(), title: await page.title() };
  },
});

const snapshot = tool({
  name: "snapshot",
  description:
    "Return a readable snapshot of the current page: title, URL, visible text (capped), and a list of links. Call BEFORE extract so you never have to guess CSS selectors.",
  parameters: z.object({
    maxChars: z.number().int().positive().max(10_000).default(4_000),
    maxLinks: z.number().int().positive().max(200).default(50),
  }),
  execute: async ({ maxChars, maxLinks }) => {
    if (!page) throw new Error("open_session first.");
    return (await page.evaluate(
      ({ maxChars, maxLinks }: { maxChars: number; maxLinks: number }) => {
        const text = (document.body.innerText || "").slice(0, maxChars);
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, maxLinks)
          .map((a) => {
            const anchor = a as HTMLAnchorElement;
            const t = (anchor.innerText || anchor.textContent || "").trim().slice(0, 120);
            return { text: t, href: anchor.href };
          })
          .filter((l) => l.text && l.href);
        return { url: location.href, title: document.title, text, links };
      },
      { maxChars, maxLinks }
    )) as { url: string; title: string; text: string; links: { text: string; href: string }[] };
  },
});

const extract = tool({
  name: "extract",
  description:
    "Extract structured rows from the current page using CSS selectors. Prefer calling snapshot() first.",
  parameters: z.object({
    rowSelector: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      selector: z.string(),
      attr: z.string().nullable(),
    })).min(1).max(10),
    limit: z.number().int().positive().max(20).default(10),
  }),
  execute: async ({ rowSelector, fields, limit }) => {
    if (!page) throw new Error("open_session first.");
    const items = (await page.evaluate(
      ({ rowSelector, fields, limit }: {
        rowSelector: string;
        fields: { name: string; selector: string; attr: string | null }[];
        limit: number;
      }) => {
        const rows = Array.from(document.querySelectorAll(rowSelector)).slice(0, limit);
        return rows.map((row) => {
          const item: Record<string, string> = {};
          for (const f of fields) {
            const el = f.selector ? (row.querySelector(f.selector) as Element | null) : row;
            if (!el) { item[f.name] = ""; continue; }
            item[f.name] = f.attr
              ? (el.getAttribute(f.attr) ?? "").trim()
              : (((el as HTMLElement).innerText ?? el.textContent ?? "")).trim();
          }
          return item;
        });
      },
      { rowSelector, fields, limit }
    )) as Record<string, string>[];
    return { count: items.length, items };
  },
});
```

### Step 5: Build the Agent

Give the agent instructions, tools, a model, and an `outputType` (Zod schema) for the final answer. Unlike some providers that force JSON-only mode when you ask for structured output, **OpenAI supports `outputType` + tools together** — the agent uses tools freely and still returns a validated final answer.

```typescript Typescript -wcn -f index.ts
const FinalReport = z.object({
  summary: z.string().describe("One-paragraph summary of what these repos have in common."),
  repos: z.array(z.object({
    name: z.string(),
    url: z.string(),
    stars: z.string().nullable(),
    description: z.string().nullable(),
  })).min(1).max(5),
});

const agent = new Agent({
  name: "SteelResearch",
  instructions: [
    "You operate a Steel cloud browser via tools.",
    "Workflow: (1) open_session, (2) navigate to the target URL,",
    "(3) snapshot to see the page's text and links,",
    "(4) only call extract when you need structured rows beyond snapshot,",
    "(5) return the final FinalReport.",
    "Prefer snapshot's links list over guessing selectors. Do not invent data.",
  ].join(" "),
  model: "gpt-5-mini",
  tools: [openSession, navigate, snapshot, extract],
  outputType: FinalReport,
});
```

### Step 6: Run and clean up

```typescript Typescript -wcn -f index.ts
async function main() {
  try {
    const result = await run(
      agent,
      "Go to https://github.com/trending/python?since=daily and return the top 3 AI/ML-related repositories. For each, give name (owner/repo), GitHub URL, star count as shown, and the repo description.",
      { maxTurns: 15 }
    );
    console.log(JSON.stringify(result.finalOutput, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

#### Run It

```bash Terminal -wc
npm start
```

### Swap the model

`gpt-5-mini` is the default here because it's fast enough for interactive iteration. Swap up to `gpt-5` when you need higher-quality reasoning on harder pages — expect 15-40s per turn because of its reasoning stage.

```typescript
const agent = new Agent({ /* ... */, model: "gpt-5" }); // slower, better reasoning
```

### Next Steps

*   **OpenAI Agents SDK (TS)**: [https://openai.github.io/openai-agents-js/](https://openai.github.io/openai-agents-js/)

*   **Python quickstart**: [/integrations/openai-agents-sdk/quickstart-python](/integrations/openai-agents-sdk/quickstart-python)

*   **Steel Sessions API**: [/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **This example on GitHub**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-openai-agents-node-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-openai-agents-node-starter)


# Quickstart (Python)
URL: /integrations/openai-agents-sdk/quickstart-python

---
title: Quickstart (Python)
sidebarTitle: Quickstart (Python)
description: Build a browser agent with the OpenAI Agents SDK for Python and Steel. The agent opens a Steel session, navigates and snapshots the page, optionally extracts structured rows, and returns a Pydantic-validated final report.
llm: true
---

Scroll to the bottom for the full example.

### Requirements

*   **Steel API key**

*   **OpenAI API key**

*   **Python 3.11+**

### Step 1: Project Setup

```bash Terminal -wc
mkdir steel-openai-agents-py && \
cd steel-openai-agents-py && \
python -m venv .venv && \
source .venv/bin/activate && \
touch main.py .env
```

### Step 2: Install Dependencies

```package-install python
openai-agents steel-sdk playwright pydantic python-dotenv
```

```bash Terminal -wc
playwright install chromium
```

### Step 3: Environment Variables

```env ENV -wcn -f .env
STEEL_API_KEY=your-steel-api-key-here
OPENAI_API_KEY=your-openai-api-key-here
```

### Step 4: Define Steel tools

Each tool is an async function decorated with `@function_tool`. The SDK reads the signature and docstring to build the JSON schema automatically. Pydantic models are used where an argument needs structure.

```python Python -wcn -f main.py
import asyncio
import os
from typing import Optional

from agents import Agent, Runner, function_tool
from dotenv import load_dotenv
from playwright.async_api import Browser, Page, async_playwright
from pydantic import BaseModel, Field
from steel import Steel

load_dotenv()

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
steel = Steel(steel_api_key=STEEL_API_KEY)

_session = None
_browser: Optional[Browser] = None
_page: Optional[Page] = None
_playwright = None


@function_tool
async def open_session() -> dict:
    """Open a Steel cloud browser session. Call exactly once, before anything else."""
    global _session, _browser, _page, _playwright
    _session = steel.sessions.create()
    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.connect_over_cdp(
        f"{_session.websocket_url}&apiKey={STEEL_API_KEY}"
    )
    ctx = _browser.contexts[0]
    _page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    return {"session_id": _session.id, "live_view_url": _session.session_viewer_url}


@function_tool
async def navigate(url: str) -> dict:
    """Navigate the open session to a URL and wait for the page to load."""
    if _page is None:
        raise RuntimeError("open_session first.")
    await _page.goto(url, wait_until="domcontentloaded", timeout=45_000)
    return {"url": _page.url, "title": await _page.title()}


@function_tool
async def snapshot(max_chars: int = 4_000, max_links: int = 50) -> dict:
    """Return a readable snapshot of the current page: title, URL, visible
    text (capped), and a list of links. Call BEFORE extract so the agent
    never has to guess CSS selectors.
    """
    if _page is None:
        raise RuntimeError("open_session first.")
    return await _page.evaluate(
        """({maxChars, maxLinks}) => {
            const text = (document.body.innerText || '').slice(0, maxChars);
            const links = Array.from(document.querySelectorAll('a[href]'))
                .slice(0, maxLinks)
                .map((a) => ({
                    text: (a.innerText || a.textContent || '').trim().slice(0, 120),
                    href: a.href,
                }))
                .filter((l) => l.text && l.href);
            return { url: location.href, title: document.title, text, links };
        }""",
        {"maxChars": max_chars, "maxLinks": max_links},
    )


class FieldSpec(BaseModel):
    name: str
    selector: str = Field(
        description="CSS selector relative to the row. Empty string reads the row itself."
    )
    attr: Optional[str] = Field(
        default=None,
        description="Optional attribute to read instead of innerText (e.g. 'href').",
    )


@function_tool
async def extract(
    row_selector: str, fields: list[FieldSpec], limit: int = 10
) -> dict:
    """Extract structured rows from the current page using CSS selectors.
    Prefer calling snapshot() first to confirm the page structure.
    """
    if _page is None:
        raise RuntimeError("open_session first.")
    fields_json = [{"name": f.name, "selector": f.selector, "attr": f.attr} for f in fields]
    items = await _page.evaluate(
        """({rowSelector, fields, limit}) => {
            const rows = Array.from(
                document.querySelectorAll(rowSelector)
            ).slice(0, limit);
            return rows.map((row) => {
                const item = {};
                for (const f of fields) {
                    const el = f.selector ? row.querySelector(f.selector) : row;
                    if (!el) { item[f.name] = ''; continue; }
                    item[f.name] = f.attr
                        ? (el.getAttribute(f.attr) || '').trim()
                        : (el.innerText || el.textContent || '').trim();
                }
                return item;
            });
        }""",
        {"rowSelector": row_selector, "fields": fields_json, "limit": limit},
    )
    return {"count": len(items), "items": items}
```

:::callout
type: warn
### Don't do N×M serial CDP calls
`page.query_selector_all` + `row.query_selector` + `el.inner_text()` look fine locally but each `await` is a separate CDP round-trip to Steel's cloud browser (~200-300ms each). A 10×4 extract becomes 40 round-trips (8-12 seconds). The `page.evaluate` version above runs the whole extraction in the browser: one round-trip, &lt;500ms.
:::

### Step 5: Build the Agent

Define a Pydantic `output_type` to get a typed final answer. **OpenAI supports `output_type` + tools together**, unlike some providers that force JSON-only mode when you ask for structured output.

```python Python -wcn -f main.py
class Repo(BaseModel):
    name: str
    url: str
    stars: Optional[str] = None
    description: Optional[str] = None


class FinalReport(BaseModel):
    summary: str = Field(
        description="One-paragraph summary of what these repos have in common."
    )
    repos: list[Repo] = Field(min_length=1, max_length=5)


agent = Agent(
    name="SteelResearch",
    instructions=(
        "You operate a Steel cloud browser via tools. "
        "Workflow: (1) open_session, (2) navigate to the target URL, "
        "(3) snapshot to see the page's text and links, "
        "(4) only call extract when you need structured rows beyond snapshot, "
        "(5) return the final FinalReport. "
        "Prefer snapshot's links list over guessing selectors. Do not invent data."
    ),
    model="gpt-5-mini",
    tools=[open_session, navigate, snapshot, extract],
    output_type=FinalReport,
)
```

### Step 6: Run and clean up

```python Python -wcn -f main.py
async def main() -> None:
    try:
        result = await Runner.run(
            agent,
            input=(
                "Go to https://github.com/trending/python?since=daily and return the "
                "top 3 AI/ML-related repositories. For each, give name (owner/repo), "
                "GitHub URL, star count as shown, and the repo description."
            ),
            max_turns=15,
        )
        final: FinalReport = result.final_output
        print(final.model_dump_json(indent=2))
    finally:
        if _browser is not None:
            await _browser.close()
        if _playwright is not None:
            await _playwright.stop()
        if _session is not None:
            steel.sessions.release(_session.id)


if __name__ == "__main__":
    asyncio.run(main())
```

#### Run It

```bash Terminal -wc
python main.py
```

### Swap the model

`gpt-5-mini` is the default here because it's fast enough for interactive iteration. Swap up to `gpt-5` when you need higher-quality reasoning on harder pages — expect 15-40s per turn because of its reasoning stage.

```python
agent = Agent(..., model="gpt-5")  # slower, better reasoning
```

### Next Steps

*   **OpenAI Agents SDK (Python)**: [https://openai.github.io/openai-agents-python/](https://openai.github.io/openai-agents-python/)

*   **TypeScript quickstart**: [/integrations/openai-agents-sdk/quickstart-node](/integrations/openai-agents-sdk/quickstart-node)

*   **Steel Sessions API**: [/overview/sessions-api/overview](/overview/sessions-api/overview)

*   **This example on GitHub**: [https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-openai-agents-python-starter](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-openai-agents-python-starter)


# Overview
URL: /integrations/openai-computer-use/overview

---
title: Overview
sidebarTitle: Overview
description: OpenAI's Computer Use is an agent that combines vision capabilities with advanced reasoning to control computer interfaces and perform tasks on behalf of users through a continuous action loop.
llm: true
---
### Overview

The OpenAI Computer Use integration connects OpenAI's `gpt-5.4` model with Steel's reliable browser infrastructure via the Responses API. This integration enables AI agents to:

*   Control Steel browser sessions via the OpenAI Responses API

*   Execute real browser actions like clicking, typing, and scrolling

*   Perform complex web tasks such as form filling, searching, and navigation

*   Process visual feedback from screenshots to determine next actions

*   Implement human-in-the-loop verification for sensitive operations


By combining OpenAI's Computer Use with Steel's cloud browser infrastructure, you can build robust, scalable web automation solutions that leverage Steel's anti-bot capabilities, proxy management, and sandboxed environments.

### Requirements & Limitations

*   **OpenAI API Key**: Access to the OpenAI API with the `gpt-5.4` model (or a later model with built-in computer use)

*   **Steel API Key**: Active subscription to Steel

*   **Runtime**: Python 3.8+ or Node.js 20+

*   **Supported Environments**: Works best with Steel's browser environment (vs. desktop environments)


### Documentation

[Quickstart Guide (Python)](/integrations/openai-computer-use/quickstart-py) → Step-by-step guide to building a Simple CUA agent with Steel browser sessions in Python.

[Quickstart Guide (Node)](/integrations/openai-computer-use/quickstart-ts) → Step-by-step guide to building a Simple CUA agent with Steel browser sessions in Typescript & Node.

### Additional Resources

*   [OpenAI Computer Use Documentation](https://platform.openai.com/docs/guides/tools-computer-use) - Official documentation from OpenAI

*   [Steel Sessions API Reference](/api-reference) - Technical details for managing Steel browser sessions

*   [Cookbook Recipe (Python)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-oai-computer-use-python-starter) - Working, forkable examples of the integration in Python

*   [Cookbook Recipe (TS/Node)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-oai-computer-use-node-starter) - Working, forkable examples of the integration in TypeScript

*   [Community Discord](https://discord.gg/steel-dev) - Get help and share your implementations


# Quickstart (Python)
URL: /integrations/openai-computer-use/quickstart-py

---
title: Quickstart (Python)
sidebarTitle: Quickstart (Python)
description: How to use OpenAI Computer Use with Steel
llm: true
---

This guide will walk you through how to use OpenAI's `gpt-5.4` model (with built-in computer use) and Steel's Computer API to create AI agents that can navigate the web.

We'll be implementing a simple CUA loop that functions as described below:

![Computer use - OpenAI API](https://cdn.openai.com/API/docs/images/cua_diagram.png)

#### Prerequisites

*   Python 3.8+

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   An OpenAI API key with access to the `gpt-5.4` model


#### Step 1: Setup and Helper Functions

First, set up a virtual environment and install the required packages:

```package-install python
steel-sdk requests python-dotenv
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions and constants:

```python Python -wcn -f helpers.py
import os
import json
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime

import requests
from dotenv import load_dotenv
from steel import Steel

load_dotenv(override=True)

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"
TASK = os.getenv("TASK") or "Go to Steel.dev and find the latest news"


def format_today() -> str:
    return datetime.now().strftime("%A, %B %d, %Y")


BROWSER_SYSTEM_PROMPT = f"""<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Interact only through the computer tool (mouse/keyboard/scroll/screenshots). Do not call navigation functions.
  - Today's date is {format_today()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - Before acting, take a screenshot to observe state.
  - When typing into any input:
    * Clear with Ctrl/⌘+A, then Delete.
    * After submitting (Enter or clicking a button), call wait(1–2s) once, then take a single screenshot and move the mouse aside.
    * Do not press Enter repeatedly. If the page state doesn't change after submit+wait+screenshot, change strategy (e.g., focus address bar with Ctrl/⌘+L, type the full URL, press Enter once).
  - Computer calls are slow; batch related actions together.
  - Zoom out or scroll so all relevant content is visible before reading.
  - If the first screenshot is black, click near center and screenshot again.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask clarifying questions; make reasonable assumptions and proceed.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Every assistant turn must include at least one computer action; avoid text-only turns.
  - Avoid repetition: never repeat the same action sequence in consecutive turns (e.g., pressing Enter multiple times). If an action has no visible effect, pivot to a different approach.
  - If two iterations produce no meaningful progress, try a different tactic (e.g., Ctrl/⌘+L → type URL → Enter) rather than repeating the prior keys, then proceed.
  - Keep the final response concise and focused on fulfilling the task.
  </TASK_EXECUTION>"""


def create_response(**kwargs):
    url = "https://api.openai.com/v1/responses"
    headers = {
        "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}",
        "Content-Type": "application/json",
    }
    openai_org = os.getenv("OPENAI_ORG")
    if openai_org:
        headers["Openai-Organization"] = openai_org

    response = requests.post(url, headers=headers, json=kwargs)
    if response.status_code != 200:
        raise RuntimeError(f"OpenAI API Error: {response.status_code} {response.text}")
    return response.json()
```


#### Step 2: Create the Agent Class

```python Python -wcn -f agent.py
import json
from typing import Any, Dict, List, Optional, Tuple

from helpers import (
    STEEL_API_KEY,
    BROWSER_SYSTEM_PROMPT,
    create_response,
)
from steel import Steel


class Agent:
    def __init__(self):
        self.steel = Steel(steel_api_key=STEEL_API_KEY)
        self.session = None
        self.model = "gpt-5.4"
        self.viewport_width = 1440
        self.viewport_height = 900
        self.system_prompt = BROWSER_SYSTEM_PROMPT
        self.tools = [{"type": "computer"}]
        self.print_steps = True
        self.auto_acknowledge_safety = True

    def center(self) -> Tuple[int, int]:
        return (self.viewport_width // 2, self.viewport_height // 2)

    def to_number(self, v: Any, default: float = 0.0) -> float:
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                return default
        return default

    def to_coords(self, x: Any = None, y: Any = None) -> Tuple[int, int]:
        if x is None or y is None:
            return self.center()
        return (
            int(self.to_number(x, self.center()[0])),
            int(self.to_number(y, self.center()[1])),
        )

    def split_keys(self, k: Optional[Any]) -> List[str]:
        if isinstance(k, list):
            return [str(s) for s in k if s]
        if isinstance(k, str) and k.strip():
            return [s.strip() for s in k.split("+") if s.strip()]
        return []

    def normalize_key(self, key: str) -> str:
        if not isinstance(key, str) or not key:
            return key
        k = key.strip()
        upper = k.upper()
        synonyms = {
            "ENTER": "Enter",
            "RETURN": "Enter",
            "ESC": "Escape",
            "ESCAPE": "Escape",
            "TAB": "Tab",
            "BACKSPACE": "Backspace",
            "BKSP": "Backspace",
            "DELETE": "Delete",
            "DEL": "Delete",
            "SPACE": "Space",
            "CTRL": "Control",
            "CONTROL": "Control",
            "ALT": "Alt",
            "SHIFT": "Shift",
            "META": "Meta",
            "SUPER": "Meta",
            "CMD": "Meta",
            "COMMAND": "Meta",
            "UP": "ArrowUp",
            "DOWN": "ArrowDown",
            "LEFT": "ArrowLeft",
            "RIGHT": "ArrowRight",
            "ARROWUP": "ArrowUp",
            "ARROWDOWN": "ArrowDown",
            "ARROWLEFT": "ArrowLeft",
            "ARROWRIGHT": "ArrowRight",
            "HOME": "Home",
            "END": "End",
            "PAGEUP": "PageUp",
            "PAGEDOWN": "PageDown",
            "INSERT": "Insert",
        }
        if upper in synonyms:
            return synonyms[upper]
        if upper.startswith("F") and upper[1:].isdigit():
            return "F" + upper[1:]
        if len(k) == 1 and k.isalpha() and k.isupper():
            return k.lower()
        return k

    def normalize_keys(self, keys: List[str]) -> List[str]:
        return [self.normalize_key(k) for k in keys]

    def initialize(self) -> None:
        width = self.viewport_width
        height = self.viewport_height
        self.session = self.steel.sessions.create(
            dimensions={"width": width, "height": height},
            block_ads=True,
            api_timeout=900000,
        )
        print("Steel Session created successfully!")
        print(f"View live session at: {self.session.session_viewer_url}")

    def cleanup(self) -> None:
        if self.session:
            print("Releasing Steel session...")
            self.steel.sessions.release(self.session.id)
            print(
                f"Session completed. View replay at {self.session.session_viewer_url}"
            )
            self.session = None

    def take_screenshot(self) -> str:
        resp = self.steel.sessions.computer(self.session.id, action="take_screenshot")
        img = getattr(resp, "base64_image", None)
        if not img:
            raise RuntimeError("No screenshot returned from Steel")
        return img

    def map_button(self, btn: Optional[str]) -> str:
        b = (btn or "left").lower()
        if b in ("left", "right", "middle", "back", "forward"):
            return b
        return "left"

    def execute_computer_action(
        self, action_type: str, action_args: Dict[str, Any]
    ) -> str:
        body: Dict[str, Any]

        if action_type == "move":
            coords = self.to_coords(action_args.get("x"), action_args.get("y"))
            body = {
                "action": "move_mouse",
                "coordinates": [coords[0], coords[1]],
                "screenshot": True,
            }

        elif action_type in ("click",):
            coords = self.to_coords(action_args.get("x"), action_args.get("y"))
            button = self.map_button(action_args.get("button"))
            num_clicks = int(self.to_number(action_args.get("num_clicks"), 1))
            payload = {
                "action": "click_mouse",
                "button": button,
                "coordinates": [coords[0], coords[1]],
                "screenshot": True,
            }
            if num_clicks > 1:
                payload["num_clicks"] = num_clicks
            body = payload

        elif action_type in ("doubleClick", "double_click"):
            coords = self.to_coords(action_args.get("x"), action_args.get("y"))
            body = {
                "action": "click_mouse",
                "button": "left",
                "coordinates": [coords[0], coords[1]],
                "num_clicks": 2,
                "screenshot": True,
            }

        elif action_type == "drag":
            path = action_args.get("path") or []
            steel_path: List[List[int]] = []
            for p in path:
                steel_path.append(list(self.to_coords(p.get("x"), p.get("y"))))
            if len(steel_path) < 2:
                cx, cy = self.center()
                tx, ty = self.to_coords(action_args.get("x"), action_args.get("y"))
                steel_path = [[cx, cy], [tx, ty]]
            body = {"action": "drag_mouse", "path": steel_path, "screenshot": True}

        elif action_type == "scroll":
            coords: Optional[Tuple[int, int]] = None
            if action_args.get("x") is not None or action_args.get("y") is not None:
                coords = self.to_coords(action_args.get("x"), action_args.get("y"))
            delta_x = int(self.to_number(action_args.get("scroll_x"), 0))
            delta_y = int(self.to_number(action_args.get("scroll_y"), 0))
            body = {
                "action": "scroll",
                "screenshot": True,
            }
            if coords:
                body["coordinates"] = [coords[0], coords[1]]
            if delta_x:
                body["delta_x"] = delta_x
            if delta_y:
                body["delta_y"] = delta_y

        elif action_type == "type":
            text = action_args.get("text") or ""
            body = {"action": "type_text", "text": text, "screenshot": True}

        elif action_type == "keypress":
            keys = action_args.get("keys")
            keys_list = self.split_keys(keys)
            normalized = self.normalize_keys(keys_list)
            body = {"action": "press_key", "keys": normalized, "screenshot": True}

        elif action_type == "wait":
            ms = self.to_number(action_args.get("ms"), 1000)
            seconds = max(0.001, ms / 1000.0)
            body = {"action": "wait", "duration": seconds, "screenshot": True}

        elif action_type == "screenshot":
            return self.take_screenshot()

        else:
            return self.take_screenshot()

        resp = self.steel.sessions.computer(
            self.session.id, **{k: v for k, v in body.items() if v is not None}
        )
        img = getattr(resp, "base64_image", None)
        return img if img else self.take_screenshot()

    def handle_item(self, item: Dict[str, Any]) -> List[Dict[str, Any]]:
        if item["type"] == "message":
            if self.print_steps and item.get("content") and len(item["content"]) > 0:
                print(item["content"][0].get("text", ""))
            return []

        if item["type"] == "function_call":
            if self.print_steps:
                print(f"{item['name']}({item['arguments']})")
            return [
                {
                    "type": "function_call_output",
                    "call_id": item["call_id"],
                    "output": "success",
                }
            ]

        if item["type"] == "computer_call":
            action = item["action"]
            action_type = action["type"]
            action_args = {k: v for k, v in action.items() if k != "type"}

            if self.print_steps:
                print(f"{action_type}({json.dumps(action_args)})")

            screenshot_base64 = self.execute_computer_action(action_type, action_args)

            pending_checks = item.get("pending_safety_checks", []) or []
            for check in pending_checks:
                if self.auto_acknowledge_safety:
                    print(f"⚠️  Auto-acknowledging safety check: {check.get('message')}")
                else:
                    raise RuntimeError(f"Safety check failed: {check.get('message')}")

            call_output = {
                "type": "computer_call_output",
                "call_id": item["call_id"],
                "acknowledged_safety_checks": pending_checks,
                "output": {
                    "type": "computer_screenshot",
                    "image_url": f"data:image/png;base64,{screenshot_base64}",
                },
            }
            return [call_output]

        return []

    def execute_task(
        self,
        task: str,
        print_steps: bool = True,
        max_iterations: int = 50,
    ) -> str:
        self.print_steps = print_steps

        input_items: List[Dict[str, Any]] = [
            {"role": "user", "content": task},
        ]

        new_items: List[Dict[str, Any]] = []
        iterations = 0
        consecutive_no_actions = 0
        last_assistant_texts: List[str] = []

        print(f"🎯 Executing task: {task}")
        print("=" * 60)

        def detect_repetition(text: str) -> bool:
            if len(last_assistant_texts) < 2:
                return False
            words1 = text.lower().split()
            for prev in last_assistant_texts:
                words2 = prev.lower().split()
                common = [w for w in words1 if w in words2]
                if len(common) / max(len(words1), len(words2)) > 0.8:
                    return True
            return False

        while iterations < max_iterations:
            iterations += 1
            has_actions = False

            if new_items and new_items[-1].get("role") == "assistant":
                content = new_items[-1].get("content", [])
                last_text = content[0].get("text") if content else None
                if isinstance(last_text, str) and last_text:
                    if detect_repetition(last_text):
                        print("🔄 Repetition detected - stopping execution")
                        last_assistant_texts.append(last_text)
                        break
                    last_assistant_texts.append(last_text)
                    if len(last_assistant_texts) > 3:
                        last_assistant_texts.pop(0)

            try:
                response = create_response(
                    model=self.model,
                    instructions=self.system_prompt,
                    input=[*input_items, *new_items],
                    tools=self.tools,
                    reasoning={"effort": "medium"},
                    parallel_tool_calls=False,
                    truncation="auto",
                )

                if "output" not in response:
                    raise RuntimeError("No output from model")

                for item in response["output"]:
                    new_items.append(item)
                    if item.get("type") in ("computer_call", "function_call"):
                        has_actions = True
                    new_items.extend(self.handle_item(item))

                if not has_actions:
                    consecutive_no_actions += 1
                    if consecutive_no_actions >= 3:
                        print("⚠️  No actions for 3 consecutive iterations - stopping")
                        break
                else:
                    consecutive_no_actions = 0

            except Exception as error:
                print(f"❌ Error during task execution: {error}")
                raise

        if iterations >= max_iterations:
            print(f"⚠️  Task execution stopped after {max_iterations} iterations")

        assistant_messages = [i for i in new_items if i.get("role") == "assistant"]
        if assistant_messages:
            content = assistant_messages[-1].get("content") or []
            if content and content[0].get("text"):
                return content[0]["text"]

        return "Task execution completed (no final message)"
```


#### Step 3: Create the Main Script

```python Python -wcn -f main.py
import sys
import time

from helpers import STEEL_API_KEY, OPENAI_API_KEY, TASK
from agent import Agent


def main():
    print("🚀 Steel + OpenAI Computer Use Assistant")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print(
            "⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
        )
        print("   Get your API key at: https://app.steel.dev/settings/api-keys")
        sys.exit(1)

    if OPENAI_API_KEY == "your-openai-api-key-here":
        print(
            "⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key"
        )
        print("   Get your API key at: https://platform.openai.com/")
        sys.exit(1)

    print("\nStarting Steel session...")
    agent = Agent()

    try:
        agent.initialize()
        print("✅ Steel session started!")

        start_time = time.time()

        try:
            result = agent.execute_task(TASK, True, 50)
            duration = f"{(time.time() - start_time):.1f}"

            print("\n" + "=" * 60)
            print("🎉 TASK EXECUTION COMPLETED")
            print("=" * 60)
            print(f"⏱️  Duration: {duration} seconds")
            print(f"🎯 Task: {TASK}")
            print(f"📋 Result:\n{result}")
            print("=" * 60)

        except Exception as e:
            print(f"❌ Task execution failed: {e}")
            raise

    except Exception as e:
        print(f"❌ Failed to start Steel session: {e}")
        print("Please check your STEEL_API_KEY and internet connection.")
        raise

    finally:
        agent.cleanup()


if __name__ == "__main__":
    main()
```


#### Running Your Agent

Execute your script to start an interactive AI browser session:

```bash Terminal -wc
python main.py
```

You will see the session URL printed in the console. You can view the live browser session by opening this URL in your web browser.

The agent will execute the task defined in the `TASK` environment variable or the default task. You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Search for the latest news on artificial intelligence"
python main.py
```


#### Next Steps

*   Explore the [Steel API documentation](/overview) for more advanced features

*   Check out the [OpenAI documentation](https://platform.openai.com/docs/guides/tools-computer-use) for more information about computer use with `gpt-5.4`

*   Add additional features like session recording or multi-session management


# Quickstart (Typescript)
URL: /integrations/openai-computer-use/quickstart-ts

---
title: Quickstart (Typescript)
sidebarTitle: Quickstart (Typescript)
description: How to use OpenAI Computer Use with Steel
llm: true
---

This guide will walk you through how to use OpenAI's `gpt-5.4` model (with built-in computer use) and Steel's Computer API to create AI agents that can navigate the web.

We'll be implementing a simple CUA loop that functions as described below:

![Computer use - OpenAI API](https://cdn.openai.com/API/docs/images/cua_diagram.png)

#### Prerequisites

*   Node.js 20+

*   A Steel API key ([sign up here](https://steel.dev/))

*   An OpenAI API key with access to the `gpt-5.4` model


#### Step 1: Setup and Helper Functions

First, create a project directory and install the required packages:

```bash Terminal -wc
# Create a project directory
mkdir steel-openai-computer-use
cd steel-openai-computer-use

# Initialize package.json
npm init -y

# Install required packages
npm install steel-sdk dotenv
npm install -D @types/node typescript ts-node
```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
TASK=Go to Steel.dev and find the latest news
```


Create a file with helper functions, constants, and type definitions:

```typescript Typescript -wcn -f helpers.ts
import * as dotenv from "dotenv";
import { Steel } from "steel-sdk";

dotenv.config();

export const STEEL_API_KEY = process.env.STEEL_API_KEY || "your-steel-api-key-here";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "your-openai-api-key-here";
export const TASK = process.env.TASK || "Go to Steel.dev and find the latest news";

export function formatToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(new Date());
}

export const BROWSER_SYSTEM_PROMPT = `<BROWSER_ENV>
  - You control a headful Chromium browser running in a VM with internet access.
  - Interact only through the computer tool (mouse/keyboard/scroll/screenshots). Do not call navigation functions.
  - Today's date is ${formatToday()}.
  </BROWSER_ENV>
  
  <BROWSER_CONTROL>
  - Before acting, take a screenshot to observe state.
  - When typing into any input:
    * Clear with Ctrl/⌘+A, then Delete.
    * After submitting (Enter or clicking a button), take another screenshot and move the mouse aside.
  - Computer calls are slow; batch related actions together.
  - Zoom out or scroll so all relevant content is visible before reading.
  - If the first screenshot is black, click near center and screenshot again.
  </BROWSER_CONTROL>
  
  <TASK_EXECUTION>
  - You receive exactly one natural-language task and no further user feedback.
  - Do not ask clarifying questions; make reasonable assumptions and proceed.
  - Prefer minimal, high-signal actions that move directly toward the goal.
  - Keep the final response concise and focused on fulfilling the task.
  </TASK_EXECUTION>`;

export interface MessageItem {
  type: "message";
  content: Array<{ text: string }>;
}

export interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ComputerCallItem {
  type: "computer_call";
  call_id: string;
  action: {
    type: string;
    [key: string]: any;
  };
  pending_safety_checks?: Array<{
    id: string;
    message: string;
  }>;
}

export interface OutputItem {
  type: "computer_call_output" | "function_call_output";
  call_id: string;
  acknowledged_safety_checks?: Array<{
    id: string;
    message: string;
  }>;
  output?:
    | {
        type: string;
        image_url?: string;
      }
    | string;
}

export interface ResponseItem {
  id: string;
  output: (MessageItem | FunctionCallItem | ComputerCallItem)[];
}

export type Coordinates = [number, number];

export interface BaseActionRequest {
  screenshot?: boolean;
  hold_keys?: string[];
}

export type ComputerActionRequest =
  | (BaseActionRequest & { action: "move_mouse"; coordinates: Coordinates })
  | (BaseActionRequest & {
      action: "click_mouse";
      button: "left" | "right" | "middle" | "back" | "forward";
      coordinates?: Coordinates;
      num_clicks?: number;
      click_type?: "down" | "up" | "click";
    })
  | (BaseActionRequest & { action: "drag_mouse"; path: Coordinates[] })
  | (BaseActionRequest & {
      action: "scroll";
      coordinates?: Coordinates;
      delta_x?: number;
      delta_y?: number;
    })
  | (BaseActionRequest & { action: "press_key"; keys: string[]; duration?: number })
  | (BaseActionRequest & { action: "type_text"; text: string })
  | (BaseActionRequest & { action: "wait"; duration: number })
  | { action: "take_screenshot" }
  | { action: "get_cursor_position" };

export async function createResponse(params: any): Promise<ResponseItem> {
  const url = "https://api.openai.com/v1/responses";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  const openaiOrg = process.env.OPENAI_ORG;
  if (openaiOrg) {
    headers["Openai-Organization"] = openaiOrg;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API Error: ${response.status} ${errorText}`);
  }

  return (await response.json()) as ResponseItem;
}

export { Steel };
```


#### Step 2: Create the Agent Class

```typescript Typescript -wcn -f agent.ts
import {
  Steel,
  STEEL_API_KEY,
  BROWSER_SYSTEM_PROMPT,
  Coordinates,
  ComputerActionRequest,
  MessageItem,
  FunctionCallItem,
  ComputerCallItem,
  OutputItem,
  createResponse,
} from "./helpers";

export class Agent {
  private steel: Steel;
  private session: any | null = null;
  private model: string;
  private tools: any[];
  private viewportWidth: number;
  private viewportHeight: number;
  private systemPrompt: string;
  private printSteps: boolean = true;
  private autoAcknowledgeSafety: boolean = true;

  constructor() {
    this.steel = new Steel({ steelAPIKey: STEEL_API_KEY });
    this.model = "gpt-5.4";
    this.viewportWidth = 1440;
    this.viewportHeight = 900;
    this.systemPrompt = BROWSER_SYSTEM_PROMPT;
    this.tools = [{ type: "computer" }];
  }

  private center(): [number, number] {
    return [
      Math.floor(this.viewportWidth / 2),
      Math.floor(this.viewportHeight / 2),
    ];
  }

  private toNumber(v: any, def = 0): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : def;
    }
    return def;
  }

  private toCoords(x?: any, y?: any): Coordinates {
    const xx = this.toNumber(x, this.center()[0]);
    const yy = this.toNumber(y, this.center()[1]);
    return [xx, yy];
  }

  private splitKeys(k?: string | string[]): string[] {
    if (Array.isArray(k)) return k.filter(Boolean) as string[];
    if (!k) return [];
    return k
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private mapButton(btn?: string): "left" | "right" | "middle" | "back" | "forward" {
    const b = (btn || "left").toLowerCase();
    if (b === "right" || b === "middle" || b === "back" || b === "forward") return b;
    return "left";
  }

  private normalizeKey(key: string): string {
    if (!key) return key;
    const k = String(key).trim();
    const upper = k.toUpperCase();
    const synonyms: Record<string, string> = {
      ENTER: "Enter",
      RETURN: "Enter",
      ESC: "Escape",
      ESCAPE: "Escape",
      TAB: "Tab",
      BACKSPACE: "Backspace",
      BKSP: "Backspace",
      DELETE: "Delete",
      DEL: "Delete",
      SPACE: "Space",
      CTRL: "Control",
      CONTROL: "Control",
      ALT: "Alt",
      SHIFT: "Shift",
      META: "Meta",
      SUPER: "Meta",
      CMD: "Meta",
      COMMAND: "Meta",
      UP: "ArrowUp",
      DOWN: "ArrowDown",
      LEFT: "ArrowLeft",
      RIGHT: "ArrowRight",
      ARROWUP: "ArrowUp",
      ARROWDOWN: "ArrowDown",
      ARROWLEFT: "ArrowLeft",
      ARROWRIGHT: "ArrowRight",
      HOME: "Home",
      END: "End",
      PAGEUP: "PageUp",
      PAGEDOWN: "PageDown",
      INSERT: "Insert",
    };
    if (upper in synonyms) return synonyms[upper];
    if (upper.startsWith("F") && /^\d+$/.test(upper.slice(1))) {
      return "F" + upper.slice(1);
    }
    if (k.length === 1 && /[A-Z]/.test(k)) return k.toLowerCase();
    return k;
  }

  private normalizeKeys(keys: string[]): string[] {
    return keys.map((k) => this.normalizeKey(k));
  }

  async initialize(): Promise<void> {
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    this.session = await this.steel.sessions.create({
      dimensions: { width, height },
      blockAds: true,
      timeout: 900000,
    });
    console.log("Steel Session created successfully!");
    console.log(`View live session at: ${this.session.sessionViewerUrl}`);
  }

  async cleanup(): Promise<void> {
    if (this.session) {
      console.log("Releasing Steel session...");
      await this.steel.sessions.release(this.session.id);
      console.log(
        `Session completed. View replay at ${this.session.sessionViewerUrl}`
      );
      this.session = null;
    }
  }

  private async takeScreenshot(): Promise<string> {
    const resp: any = await this.steel.sessions.computer(this.session!.id, {
      action: "take_screenshot",
    });
    const img: string | undefined = resp?.base64_image;
    if (!img) throw new Error("No screenshot returned from Steel");
    return img;
  }

  private async executeComputerAction(
    actionType: string,
    actionArgs: any
  ): Promise<string> {
    let body: ComputerActionRequest | null = null;

    switch (actionType) {
      case "move": {
        const coords = this.toCoords(actionArgs.x, actionArgs.y);
        body = {
          action: "move_mouse",
          coordinates: coords,
          screenshot: true,
        };
        break;
      }
      case "click": {
        const coords = this.toCoords(actionArgs.x, actionArgs.y);
        const button = this.mapButton(actionArgs.button);
        const clicks = this.toNumber(actionArgs.num_clicks, 1);
        body = {
          action: "click_mouse",
          button,
          coordinates: coords,
          ...(clicks > 1 ? { num_clicks: clicks } : {}),
          screenshot: true,
        };
        break;
      }
      case "doubleClick":
      case "double_click": {
        const coords = this.toCoords(actionArgs.x, actionArgs.y);
        body = {
          action: "click_mouse",
          button: "left",
          coordinates: coords,
          num_clicks: 2,
          screenshot: true,
        };
        break;
      }
      case "drag": {
        const path = Array.isArray(actionArgs.path) ? actionArgs.path : [];
        const steelPath: Coordinates[] = path.map((p: any) =>
          this.toCoords(p.x, p.y)
        );
        if (steelPath.length < 2) {
          const [cx, cy] = this.center();
          steelPath.unshift([cx, cy]);
        }
        body = {
          action: "drag_mouse",
          path: steelPath,
          screenshot: true,
        };
        break;
      }
      case "scroll": {
        const coords =
          actionArgs.x != null || actionArgs.y != null
            ? this.toCoords(actionArgs.x, actionArgs.y)
            : undefined;
        const delta_x = this.toNumber(actionArgs.scroll_x, 0);
        const delta_y = this.toNumber(actionArgs.scroll_y, 0);
        body = {
          action: "scroll",
          ...(coords ? { coordinates: coords } : {}),
          ...(delta_x !== 0 ? { delta_x } : {}),
          ...(delta_y !== 0 ? { delta_y } : {}),
          screenshot: true,
        };
        break;
      }
      case "type": {
        const text = typeof actionArgs.text === "string" ? actionArgs.text : "";
        body = {
          action: "type_text",
          text,
          screenshot: true,
        };
        break;
      }
      case "keypress": {
        const keys = Array.isArray(actionArgs.keys)
          ? actionArgs.keys
          : this.splitKeys(actionArgs.keys);
        const normalized = this.normalizeKeys(keys);
        body = {
          action: "press_key",
          keys: normalized,
          screenshot: true,
        };
        break;
      }
      case "wait": {
        const ms = this.toNumber(actionArgs.ms, 1000);
        const seconds = Math.max(0.001, ms / 1000);
        body = {
          action: "wait",
          duration: seconds,
          screenshot: true,
        };
        break;
      }
      case "screenshot": {
        return this.takeScreenshot();
      }
      default: {
        return this.takeScreenshot();
      }
    }

    const resp: any = await this.steel.sessions.computer(
      this.session!.id,
      body!
    );
    const img: string | undefined = resp?.base64_image;
    if (img) return img;
    return this.takeScreenshot();
  }

  private async handleItem(
    item: MessageItem | FunctionCallItem | ComputerCallItem
  ): Promise<OutputItem[]> {
    if (item.type === "message") {
      if (this.printSteps) {
        console.log(item.content[0].text);
      }
      return [];
    }

    if (item.type === "function_call") {
      if (this.printSteps) {
        console.log(`${item.name}(${item.arguments})`);
      }
      return [
        {
          type: "function_call_output",
          call_id: item.call_id,
          output: "success",
        },
      ];
    }

    if (item.type === "computer_call") {
      const { action } = item;
      const actionType = action.type;
      const { type, ...actionArgs } = action;

      if (this.printSteps) {
        console.log(`${actionType}(${JSON.stringify(actionArgs)})`);
      }

      const screenshotBase64 = await this.executeComputerAction(
        actionType,
        actionArgs
      );

      const pendingChecks = item.pending_safety_checks || [];
      for (const check of pendingChecks) {
        if (this.autoAcknowledgeSafety) {
          console.log(`⚠️  Auto-acknowledging safety check: ${check.message}`);
        } else {
          throw new Error(`Safety check failed: ${check.message}`);
        }
      }

      const callOutput: OutputItem = {
        type: "computer_call_output",
        call_id: item.call_id,
        acknowledged_safety_checks: pendingChecks,
        output: {
          type: "computer_screenshot",
          image_url: `data:image/png;base64,${screenshotBase64}`,
        },
      };

      return [callOutput];
    }

    return [];
  }

  async executeTask(
    task: string,
    printSteps: boolean = true,
    maxIterations: number = 50
  ): Promise<string> {
    this.printSteps = printSteps;

    const inputItems = [
      {
        role: "user",
        content: task,
      },
    ];

    let newItems: any[] = [];
    let iterations = 0;
    let consecutiveNoActions = 0;
    let lastAssistantTexts: string[] = [];

    console.log(`🎯 Executing task: ${task}`);
    console.log("=".repeat(60));

    const detectRepetition = (text: string): boolean => {
      if (lastAssistantTexts.length < 2) return false;
      const words1 = text.toLowerCase().split(/\s+/);
      return lastAssistantTexts.some((prev) => {
        const words2 = prev.toLowerCase().split(/\s+/);
        const common = words1.filter((w) => words2.includes(w));
        return common.length / Math.max(words1.length, words2.length) > 0.8;
      });
    };

    while (iterations < maxIterations) {
      iterations++;
      let hasActions = false;

      if (
        newItems.length > 0 &&
        newItems[newItems.length - 1]?.role === "assistant"
      ) {
        const last = newItems[newItems.length - 1];
        const content = last.content?.[0]?.text;
        if (content) {
          if (detectRepetition(content)) {
            console.log("🔄 Repetition detected - stopping execution");
            lastAssistantTexts.push(content);
            break;
          }
          lastAssistantTexts.push(content);
          if (lastAssistantTexts.length > 3) lastAssistantTexts.shift();
        }
      }

      try {
        const response = await createResponse({
          model: this.model,
          instructions: this.systemPrompt,
          input: [...inputItems, ...newItems],
          tools: this.tools,
          reasoning: { effort: "medium" },
          parallel_tool_calls: false,
          truncation: "auto",
        });

        if (!response.output) {
          throw new Error("No output from model");
        }

        newItems.push(...response.output);

        for (const item of response.output) {
          if (item.type === "computer_call" || item.type === "function_call") {
            hasActions = true;
          }
          const handleResult = await this.handleItem(item);
          newItems.push(...handleResult);
        }

        if (!hasActions) {
          consecutiveNoActions++;
          if (consecutiveNoActions >= 3) {
            console.log(
              "⚠️  No actions for 3 consecutive iterations - stopping"
            );
            break;
          }
        } else {
          consecutiveNoActions = 0;
        }
      } catch (error) {
        console.error(`❌ Error during task execution: ${error}`);
        throw error;
      }
    }

    if (iterations >= maxIterations) {
      console.warn(
        `⚠️  Task execution stopped after ${maxIterations} iterations`
      );
    }

    const assistantMessages = newItems.filter(
      (item) => item.role === "assistant"
    );
    const finalMessage = assistantMessages[assistantMessages.length - 1];

    return (
      finalMessage?.content?.[0]?.text ||
      "Task execution completed (no final message)"
    );
  }
}
```


#### Step 3: Create the Main Script

```typescript Typescript -wcn -f main.ts
import { Agent } from "./agent";
import { STEEL_API_KEY, OPENAI_API_KEY, TASK } from "./helpers";

async function main(): Promise<void> {
  console.log("🚀 Steel + OpenAI Computer Use Assistant");
  console.log("=".repeat(60));

  if (STEEL_API_KEY === "your-steel-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-steel-api-key-here' with your actual Steel API key"
    );
    console.warn(
      "   Get your API key at: https://app.steel.dev/settings/api-keys"
    );
    throw new Error("Set STEEL_API_KEY");
  }

  if (OPENAI_API_KEY === "your-openai-api-key-here") {
    console.warn(
      "⚠️  WARNING: Please replace 'your-openai-api-key-here' with your actual OpenAI API key"
    );
    console.warn("   Get your API key at: https://platform.openai.com/");
    throw new Error("Set OPENAI_API_KEY");
  }

  console.log("\nStarting Steel session...");
  const agent = new Agent();

  try {
    await agent.initialize();
    console.log("✅ Steel session started!");

    const startTime = Date.now();
    const result = await agent.executeTask(TASK, true, 50);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 TASK EXECUTION COMPLETED");
    console.log("=".repeat(60));
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log(`🎯 Task: ${TASK}`);
    console.log(`📋 Result:\n${result}`);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`❌ Failed to run: ${error}`);
    throw error;
  } finally {
    await agent.cleanup();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Task execution failed:", error);
    process.exit(1);
  });
```


#### Running Your Agent

Execute your script to start an interactive AI browser session:

```bash Terminal -wc
npx ts-node main.ts
```

The agent will execute the task defined in the `TASK` environment variable or the default task. You can modify the task by setting the environment variable:

```bash Terminal -wc
export TASK="Research the top 5 electric vehicles with the longest range"
npx ts-node main.ts
```

You'll see each action the agent takes displayed in the console, and you can view the live browser session by opening the session URL in your web browser.

#### Next Steps

*   Explore the [Steel API documentation](/overview) for more advanced features

*   Check out the [OpenAI documentation](https://platform.openai.com/docs/guides/tools-computer-use) for more information about computer use with `gpt-5.4`

*   Add additional features like session recording or multi-session management


# Quickstart
URL: /integrations/replit/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: Quickstart guide for using Steel with Replit
llm: true
---
### Overview

Run Steel browser automation scripts directly in Replit's cloud environment without any local setup. Write, test, and deploy your Steel scripts with support for multiple languages including Python and Node.js. This combination is perfect for quick prototyping, collaborative development, or running scheduled automation tasks without managing infrastructure.

### Requirements & Limitations

*   Steel API key (any plan, get a free key [here](https://app.steel.dev/settings/api-keys))

*   Replit account (free tier available)

*   Works with Python & Node.js (See full list of supported languages [here](https://replit.com/templates/languages))


### Starter Templates

*   [**Steel Puppeteer Starter**](https://replit.com/@steel-dev/steel-puppeteer-starter) - Node.js template using Puppeteer

*   [**Steel Playwright Starter**](https://replit.com/@steel-dev/steel-playwright-starter) - Node.js template using Playwright

*   [**Steel Playwright Python Starter**](https://replit.com/@steel-dev/steel-playwright-python-starter) - Python template using Playwright

*   [**Steel Selenium Starter**](https://replit.com/@steel-dev/steel-selenium-starter) - Python template using Selenium


#### Running Repls

To run any of these starter templates:

1.  Hit "Remix this Template" to fork the template (requires a Replit account, which is free to create)

2.  Add your `STEEL_API_KEY` to the secrets pane (located under "Tools" on the left hand pane)

    **_Note:_** Don't have an API key? Get a free key at [app.steel.dev/settings/api-keys](http://app.steel.dev/settings/api-keys)

3.  Hit Run


### Additional Resources

*   [**Replit Documentation**](https://docs.replit.com/home) - Learn more about Replit's features

*   [**Session API Overview**](/overview/sessions-api/overview) - Learn about Steel’s Sessions API

*   [**Support**](/overview/need-help) - Get help from the Steel team


# Quickstart
URL: /integrations/stackblitz-bolt.new/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: StackBlitz is an instant fullstack web IDE for the JavaScript ecosystem. It's powered by WebContainers, the first WebAssembly-based operating system which boots the Node.js environment in milliseconds, securely within your browser tab.
llm: true
---
### Overview

Run Steel browser automation scripts with JavaScript/TypeScript directly in StackBlitz without any local setup or installation. This browser-based environment makes it perfect for quick prototyping, sharing running examples, or collaborative development.

Plus, with [Bolt.new](http://bolt.new/) (StackBlitz's AI-powered web development agent), you can use natural language to write scripts and build full-stack applications around Steel's capabilities—all instantly in your browser.

While StackBlitz has limited Python support, we currently only offer TypeScript templates for Steel.

### Requirements & Limitations

*   Steel API key (any plan, get a free key [here](https://app.steel.dev/settings/api-keys))

*   Supported languages: JavaScript and TypeScript

*   No account required to run code (only to save changes)


### Starter Templates

*   [**Steel Puppeteer Starter**](https://stackblitz.com/edit/steel-puppeteer-starter) - Node.js template using Puppeteer

*   [**Steel Playwright Starter**](https://stackblitz.com/edit/steel-playwright-starter) - Node.js template using Playwright


### Running any template

To run any of the starter templates:

1.  Click on the template link above to open it in StackBlitz

2.  Set your `STEEL_API_KEY` in one of two ways:

    *   Export it in the terminal: `export STEEL_API_KEY=your_key_here`

    *   Create a `.env` file and add: `STEEL_API_KEY=your_key_here`


    Note: Don't have an API key? Get a free key at [app.steel.dev/settings/api-keys](http://app.steel.dev/settings/api-keys)

3.  Run the command `npm run` in the terminal to run the script


No account is required to run or even edit the templates - you only need to sign in if you want to save your changes.

### AI-Powered Development with [Bolt.new](http://bolt.new/)

All our StackBlitz templates can be opened in [Bolt.new](http://bolt.new/), an AI-powered web development agent built on StackBlitz's WebContainer technology. With [Bolt.new](http://bolt.new/), you can:

*   Use natural language prompts to modify Steel automation scripts

*   Build full-stack applications around Steel's capabilities

*   Get AI assistance while developing your browser automation workflows

*   Deploy your projects with zero configuration


Look for the _"Open in_ [_Bolt.new_](http://bolt.new/)_"_ button on our templates to get started with AI-assisted development.

### Additional Resources

*   [**StackBlitz Documentation**](https://developer.stackblitz.com/) - Learn more about StackBlitz's features

*   [**Session API Overview**](/overview/sessions-api/overview) - Learn about Steel’s Sessions API

*   [**Support**](/overview/need-help) - Get help from the Steel team


**Note:** Sections marked with → indicate detailed guides available.


# Overview
URL: /integrations/stagehand/overview

---
title: Overview
sidebarTitle: Overview
description: Stagehand is an open-source library that allows you to write browser automations in natural language. This integration connects Stagehand with Steel's infrastructure, allowing for seamless automation of web tasks and workflows in the cloud.
llm: true
---
### Requirements & Limitations

*   **OpenAI API Key**: Access to the OpenAI API

*   **Steel API Key**: Active subscription to Steel

*   **Node.js or Python Environment**: Support for Stagehand in your preferred language

*   **Supported Environments**: Works best with Steel's browser environment


### Documentation

[Quickstart Guide (Node.js)](/integrations/stagehand/quickstart-ts) → Step-by-step guide to building browser automation with Steel sessions in TypeScript & Node.

[Quickstart Guide (Python)](/integrations/stagehand/quickstart-py) → Step-by-step guide to building browser automation with Steel sessions in Python.

### Additional Resources

[Stagehand Documentation](https://docs.stagehand.dev/first-steps/introduction) - Official documentation for Stagehand

[Steel Sessions API Reference](/api-reference#tag/sessions) - Technical details for managing Steel browser sessions

[Cookbook Recipe (Node.js)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-stagehand-node-starter) - Working, forkable examples of the integration in Node.js

[Cookbook Recipe (Python)](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-stagehand-python-starter) - Working, forkable examples of the integration in Python

[Community Discord](https://discord.gg/steel-dev) - Get help and share your implementations


# Quickstart (Python)
URL: /integrations/stagehand/quickstart-py

---
title: Quickstart (Python)
sidebarTitle: Quickstart (Python)
description: Build scripts that navigate the web using natural language instructions
llm: true
---

This guide shows you how to use Stagehand with Steel browsers to create scripts that can interact with websites using natural language commands. We'll build a simple automation that extracts data from Hacker News and demonstrates search functionality.

### Prerequisites

Ensure you have the following:

*   Python 3.9 or higher

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   An OpenAI API key ([get one here](https://platform.openai.com/))


### Step 1: Set up your environment

First install the required packages. The Python SDK was rewritten in v3 and is now published as `stagehand` (the old `stagehand-py` package is deprecated):

```package-install python
steel-sdk stagehand python-dotenv
```

Create a `.env` file with your API keys:

```env ENV -wcn -f .env
# .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```


### Step 2: Define your extraction schema

Stagehand v3 uses JSON Schema (plain dicts) for structured extraction — not Pydantic or Zod.

```python Python -wcn -f main.py
import asyncio
import os
from dotenv import load_dotenv
from steel import Steel
from stagehand import AsyncStagehand

# Load environment variables
load_dotenv()

# Get API keys from environment
STEEL_API_KEY = os.getenv("STEEL_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "stories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "rank": {"type": "integer"},
                },
                "required": ["title", "rank"],
            },
        }
    },
    "required": ["stories"],
}
```


### Step 3: Create a Steel browser session

Add the session creation logic to connect with Steel's cloud browsers:

```python Python -wcn -f main.py
async def main():
    print("🚀 Steel + Stagehand Automation")
    print("=" * 50)

    # Initialize Steel client
    client = Steel(steel_api_key=STEEL_API_KEY)

    # Create a new browser session
    session = client.sessions.create()

    print("✅ Steel browser session created!")
    print(f"View live session at: {session.session_viewer_url}")

    cdp_url = f"{session.websocket_url}&apiKey={STEEL_API_KEY}"
```


### Step 4: Configure and connect Stagehand (v3)

Stagehand v3 runs an embedded local server that drives the browser. To drive a Steel-hosted browser, start a session with `browser={"type": "local", "launchOptions": {"cdpUrl": ...}}`:

```python Python -wcn -f main.py
    stagehand = AsyncStagehand(
        server="local",
        model_api_key=OPENAI_API_KEY,
        local_ready_timeout_s=30.0,
    )

    stagehand_session = await stagehand.sessions.start(
        model_name="openai/gpt-5",
        browser={
            "type": "local",
            "launchOptions": {
                "cdpUrl": cdp_url,
            },
        },
    )
    session_id = stagehand_session.data.session_id

    print("🤖 Stagehand connected to Steel browser")
```


### Step 5: Navigate and extract data

v3's AI operations (`navigate`, `extract`, `act`, `observe`) stream Server-Sent Events. Drain the stream to get the final result:

```python Python -wcn -f main.py
    async def stream_to_result(stream, label):
        result = None
        async for event in stream:
            if event.type == "log":
                continue
            if event.data.status == "finished":
                result = event.data.result
            elif event.data.status == "error":
                raise RuntimeError(event.data.error or "unknown error")
        return result

    try:
        print("📰 Navigating to Hacker News...")
        await stagehand.sessions.navigate(
            id=session_id,
            url="https://news.ycombinator.com",
        )

        print("🔍 Extracting top stories...")
        extract_stream = stagehand.sessions.extract(
            id=session_id,
            instruction="Extract the titles and ranks of the first 5 stories on the page",
            schema=STORY_SCHEMA,
            stream_response=True,
            x_stream_response="true",
        )
        stories_data = await stream_to_result(extract_stream, "extract")

        print("\n📋 Top 5 Hacker News Stories:")
        for story in (stories_data or {}).get("stories", []):
            print(f"{story['rank']}. {story['title']}")

        print("\n✅ Automation completed successfully!")

    except Exception as error:
        print(f"❌ Error during automation: {error}")
```


### Step 6: Add proper cleanup

Always end the Stagehand session, close the client, and release the Steel session:

```python Python -wcn -f main.py
    finally:
        if session_id:
            await stagehand.sessions.end(id=session_id)
        await stagehand.close()
        if session and client:
            client.sessions.release(session.id)
            print("🧹 Resources cleaned up")

# Run the automation
if __name__ == "__main__":
    asyncio.run(main())
```


### Step 7: Run your automation

Execute your script:

```bash Terminal
python main.py
```

You should see output like this:

```bash Terminal
🚀 Steel + Stagehand Automation
==================================================
✅ Steel browser session created!
View live session at: https://app.steel.dev/v1/sessions/uuid
🤖 Stagehand connected to Steel browser
📰 Navigating to Hacker News...
🔍 Extracting top stories...

📋 Top 5 Hacker News Stories:
1. Ask HN: What are you working on this week?
2. Show HN: I built a tool to analyze my GitHub contributions
3. The future of web development
4. Why I switched from React to Vue
5. Building scalable microservices with Go

✅ Automation completed successfully!
🧹 Resources cleaned up
```


### Complete Example

Here's the complete script that puts all steps together:

```python Python -wcn -f main.py
"""
AI-powered browser automation using Stagehand with Steel browsers.
https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-stagehand-python-starter
"""

import asyncio
import os
import sys
from dotenv import load_dotenv
from steel import Steel
from stagehand import AsyncStagehand

load_dotenv()

STEEL_API_KEY = os.getenv("STEEL_API_KEY") or "your-steel-api-key-here"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or "your-openai-api-key-here"

STORY_SCHEMA = {
    "type": "object",
    "properties": {
        "stories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "rank": {"type": "integer"},
                },
                "required": ["title", "rank"],
            },
        }
    },
    "required": ["stories"],
}


async def stream_to_result(stream, label):
    result = None
    async for event in stream:
        if event.type == "log":
            continue
        if event.data.status == "finished":
            result = event.data.result
        elif event.data.status == "error":
            raise RuntimeError(event.data.error or "unknown error")
    return result


async def main():
    print("🚀 Steel + Stagehand Python Starter")
    print("=" * 60)

    if STEEL_API_KEY == "your-steel-api-key-here":
        print("⚠️  WARNING: Please set STEEL_API_KEY")
        sys.exit(1)

    if OPENAI_API_KEY == "your-openai-api-key-here":
        print("⚠️  WARNING: Please set OPENAI_API_KEY")
        sys.exit(1)

    session = None
    session_id = None
    stagehand = None
    client = None

    try:
        client = Steel(steel_api_key=STEEL_API_KEY)
        session = client.sessions.create()
        print(f"View session at {session.session_viewer_url}")

        cdp_url = f"{session.websocket_url}&apiKey={STEEL_API_KEY}"

        stagehand = AsyncStagehand(
            server="local",
            model_api_key=OPENAI_API_KEY,
            local_ready_timeout_s=30.0,
        )

        stagehand_session = await stagehand.sessions.start(
            model_name="openai/gpt-5",
            browser={"type": "local", "launchOptions": {"cdpUrl": cdp_url}},
        )
        session_id = stagehand_session.data.session_id

        await stagehand.sessions.navigate(id=session_id, url="https://news.ycombinator.com")

        extract_stream = stagehand.sessions.extract(
            id=session_id,
            instruction="Extract the titles and ranks of the first 5 stories on the page",
            schema=STORY_SCHEMA,
            stream_response=True,
            x_stream_response="true",
        )
        stories_data = await stream_to_result(extract_stream, "extract")

        print("\nTop 5 Hacker News Stories:")
        for story in (stories_data or {}).get("stories", []):
            print(f"{story['rank']}. {story['title']}")

    except Exception as error:
        print(f"Error during automation: {error}")
        raise

    finally:
        if stagehand and session_id:
            try:
                await stagehand.sessions.end(id=session_id)
            except Exception:
                pass
        if stagehand:
            await stagehand.close()
        if session and client:
            client.sessions.release(session.id)


if __name__ == "__main__":
    asyncio.run(main())
```

### Next Steps

Now that you have a working Stagehand + Steel automation, try these enhancements:

*   **Custom data extraction**: Author your own JSON schemas for different websites

*   **Complex interactions**: Use `stagehand.sessions.act(...)` for clicking, typing, and navigation

*   **Multiple pages**: Navigate through multi-step workflows

*   **Error handling**: Add retry logic and better error management


For more advanced features, check out:

*   [Stagehand documentation](https://docs.stagehand.dev/) for natural language automation

*   [Stagehand v3 Python SDK](https://docs.stagehand.dev/v3/sdk/python) for the full API reference

*   [Steel API documentation](https://docs.steel.dev/api-reference) for session management options

*   [Steel GitHub examples](https://github.com/steel-dev/steel-cookbook) for more integration patterns


# Quickstart (Typescript)
URL: /integrations/stagehand/quickstart-ts

---
title: Quickstart (Typescript)
sidebarTitle: Quickstart (Typescript)
description: Build AI agents that navigate the web using natural language instructions
llm: true
---

This guide shows you how to use Stagehand with Steel browsers to create AI agents that can interact with websites using natural language commands. We'll build a simple automation that extracts data from Hacker News and demonstrates search functionality.

### Prerequisites

Ensure you have the following:

*   Node.js 20 or higher

*   A Steel API key ([sign up here](https://app.steel.dev/))

*   An OpenAI API key ([get one here](https://platform.openai.com/))


### Step 1: Set up your project

First, create a project directory and initialize your Node.js project:

```bash Terminal -wc
# Create a project directory
mkdir steel-stagehand-starter
cd steel-stagehand-starter

# Initialize npm project
npm init -y

# Install required packages
npm install @browserbasehq/stagehand dotenv steel-sdk typescript zod

# Install dev dependencies
npm install --save-dev @types/node ts-node

```


Create a `.env` file with your API keys:

```env ENV -wcn -f .env
# .env
STEEL_API_KEY=your_steel_api_key_here
OPENAI_API_KEY=your_openai_api_key_here

```


### Step 2: Create your data schemas

```typescript Typescript -wcn -f index.ts
import { Stagehand } from "@browserbasehq/stagehand";
import Steel from "steel-sdk";
import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Define data schemas for structured extraction
const StorySchema = z.object({
  title: z.string(),
  rank: z.number()
});

const StoriesSchema = z.object({
  stories: z.array(StorySchema)
});

```


These schemas will help Stagehand extract structured data from web pages using Zod validation. Stagehand v3 supports both Zod v3 and v4.

### Step 3: Create a Steel browser session

```typescript Typescript -wcn -f index.ts
async function main() {
  console.log("🚀 Steel + Stagehand Automation");
  console.log("=".repeat(50));

  // Initialize Steel client
  const client = new Steel({
    steelAPIKey: STEEL_API_KEY,
  });

  // Create a new browser session
  const session = await client.sessions.create();

  console.log("✅ Steel browser session created!");
  console.log(`View live session at: ${session.sessionViewerUrl}`);
}

```


When you run this, you'll see a URL where you can watch your browser session live.

### Step 4: Configure and connect Stagehand

In Stagehand v3, the `modelClientOptions` + `modelName` pair has been unified into a single `model` field, and AI methods (`act`, `extract`, `observe`) live directly on the `Stagehand` instance rather than on `page`.

```typescript Typescript -wcn -f index.ts
  // Configure Stagehand to use Steel session
  const stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: {
      cdpUrl: `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
    },
    model: {
      modelName: "openai/gpt-5",
      apiKey: OPENAI_API_KEY,
    },
  });

  // Initialize Stagehand
  console.log("🤖 Initializing Stagehand...");
  await stagehand.init();

  // Grab the active page from Stagehand's context
  const page = await stagehand.context.awaitActivePage();

  console.log("Connected to Steel browser via Stagehand");

```


This connects Stagehand to your Steel browser session via Chrome DevTools Protocol.

### Step 5: Navigate and extract data

Add the automation logic to navigate to a website and extract information. In v3, `extract` takes a positional `(instruction, schema)` pair:

```typescript Typescript -wcn -f index.ts
  try {
    // Navigate to Hacker News
    console.log("📰 Navigating to Hacker News...");
    await page.goto("https://news.ycombinator.com");

    // Extract top stories using AI
    console.log("🔍 Extracting top stories...");
    const stories = await stagehand.extract(
      "extract the titles and ranks of the first 5 stories on the page",
      StoriesSchema
    );

    // Display results
    console.log("\n📋 Top 5 Hacker News Stories:");
    stories.stories.forEach((story) => {
      console.log(`${story.rank}. ${story.title}`);
    });

    console.log("\n✅ Automation completed successfully!");

  } catch (error) {
    console.error("❌ Error during automation:", error);
  }

```


You'll see the extracted story titles and rankings printed to your console.

### Step 6: Add proper cleanup

Always clean up your resources when finished:

```typescript Typescript -wcn -f index.ts
  finally {
    // Close Stagehand
    if (stagehand) {
      await stagehand.close();
    }

    // Release Steel session
    if (session && client) {
      await client.sessions.release(session.id);
      console.log("🧹 Resources cleaned up");
    }
  }

// Run the automation
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

```


### Step 7: Run your automation

Execute your script:

You should see output like this:

```bash Terminal
🚀 Steel + Stagehand Automation
==================================================
✅ Steel browser session created!
View live session at: https://api.steel.dev/v1/sessions/[session-id]/player
🤖 Initializing Stagehand...
Connected to Steel browser via Stagehand
📰 Navigating to Hacker News...
🔍 Extracting top stories...

📋 Top 5 Hacker News Stories:
1. Ask HN: What are you working on this week?
2. Show HN: I built a tool to analyze my GitHub contributions
3. The future of web development
4. Why I switched from React to Vue
5. Building scalable microservices with Go

✅ Automation completed successfully!
🧹 Resources cleaned up

```


### Complete Example

Here's the complete script that puts all steps together:

```typescript Typescript -wcn -f index.ts
/*
 * AI-powered browser automation using Stagehand with Steel browsers.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import Steel from "steel-sdk";
import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const STEEL_API_KEY = process.env.STEEL_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Define data schemas for structured extraction
const StorySchema = z.object({
  title: z.string(),
  rank: z.number()
});

const StoriesSchema = z.object({
  stories: z.array(StorySchema)
});

async function main() {
  console.log("🚀 Steel + Stagehand Automation");
  console.log("=".repeat(50));

  let session: any = null;
  let stagehand: Stagehand | null = null;

  try {
    // Initialize Steel client and create session
    const client = new Steel({
      steelAPIKey: STEEL_API_KEY,
    });

    session = await client.sessions.create();

    console.log("✅ Steel browser session created!");
    console.log(`View live session at: ${session.sessionViewerUrl}`);

    // Configure and initialize Stagehand
    stagehand = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: {
        cdpUrl: `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
      },
      model: {
        modelName: "openai/gpt-5",
        apiKey: OPENAI_API_KEY!,
      },
    });

    console.log("🤖 Initializing Stagehand...");
    await stagehand.init();
    console.log("Connected to Steel browser via Stagehand");

    const page = await stagehand.context.awaitActivePage();

    // Navigate and extract data
    console.log("📰 Navigating to Hacker News...");
    await page.goto("https://news.ycombinator.com");

    console.log("🔍 Extracting top stories...");
    const stories = await stagehand.extract(
      "extract the titles and ranks of the first 5 stories on the page",
      StoriesSchema
    );

    console.log("\n📋 Top 5 Hacker News Stories:");
    stories.stories.forEach((story) => {
      console.log(`${story.rank}. ${story.title}`);
    });

    console.log("\n✅ Automation completed successfully!");

  } catch (error) {
    console.error("❌ Error during automation:", error);

  } finally {
    // Clean up resources
    if (stagehand) {
      await stagehand.close();
    }
    if (session) {
      const client = new Steel({ steelAPIKey: STEEL_API_KEY });
      await client.sessions.release(session.id);
    }
    console.log("🧹 Resources cleaned up");
  }
}

// Run the automation
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

```


### Advanced Usage Examples

#### Safer AI Actions

Pick actions that you know exist on the page — "click the 'new' link" is more reliable than "click the search button if it exists", because the LLM has to return an empty object when it can't find the element, which triggers schema-validation noise in the logs.

#### Custom Data Extraction Schema

```typescript Typescript -wcn -f schema.ts
const ProductSchema = z.object({
  products: z.array(
    z.object({
      name: z.string(),
      price: z.string(),
      rating: z.number().optional(),
      inStock: z.boolean(),
    })
  ),
});

const productData = await stagehand.extract(
  "extract product information from this e-commerce page",
  ProductSchema,
);

```


#### Complex Actions with Natural Language

```typescript Typescript -wcn -f index.ts
// Click a specific navigation link
await stagehand.act("click the 'new' link in the top navigation");

// Fill out a form using natural language
await stagehand.act(
  "fill out the contact form with name 'John Doe', email 'john@example.com', and message 'Hello!'"
);

// Navigate through multi-step processes
await stagehand.act(
  "click on the 'Sign Up' button and then fill out the registration form"
);

```


### Next Steps

Now that you have a working Stagehand + Steel automation, try these enhancements:

*   **Custom data extraction**: Create your own Zod schemas for different websites

*   **Complex interactions**: Use `stagehand.act()` for clicking, typing, and navigation

*   **Multiple pages**: Navigate through multi-step workflows

*   **Error handling**: Add retry logic and better error management


For more advanced features, check out:

*   [Stagehand documentation](https://docs.stagehand.dev/) for natural language automation

*   [Steel API documentation](https://docs.steel.dev/api-reference) for session management options

*   [Steel GitHub examples](https://github.com/steel-dev/steel-cookbook) for more integration patterns


# Overview
URL: /integrations/valtown/overview

---
title: Overview
sidebarTitle: Overview
description: Val Town is a collaborative platform for writing and deploying TypeScript functions, enabling you to build APIs and schedule tasks directly from your browser.
llm: true
---
### Overview

Val Town enables you to run Steel + Puppeteer scripts as serverless functions with one-click deployment. Write your automation code in the browser, schedule it to run on intervals, or trigger it via API endpoints - all without managing servers or containers.

Val Town runs on the Deno runtime and supports JavaScript, TypeScript, JSX, and TSX. For Puppeteer integrations, we recommend using the deno-puppeteer library as shown in the below starter template.

### Requirements

*   Steel API key (any plan, get a free key [here](https://app.steel.dev/settings/api-keys))

*   Val Town account (free tier available)

*   Basic JavaScript/TypeScript knowledge

*   Familiarity with Puppeteer


### Quickstart Template

Val.town starter

**How to use this Val:**

1.  Get a free Steel API key at [https://app.steel.dev/settings/api-keys](https://app.steel.dev/settings/api-keys)

2.  Add it to your [Val Town Environment Variables](https://www.val.town/settings/environment-variables) as `STEEL_API_KEY`

3.  Fork [this val](https://www.val.town/v/steel/steel_puppeteer_starter)

4.  Click `Run` on that val

5.  View the magic in the logs ✨


### Additional Resources

*   [**Val Town Documentation**](https://docs.val.town/) - Learn more about Val Town's features

*   [**Session API Overview**](/overview/sessions-api/overview) - Learn about Steel’s Sessions API

*   [**Support**](/overview/need-help) - Get help from the Steel team


# Quickstart
URL: /integrations/valtown/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
isLink: true
llm: false
---


# Overview
URL: /integrations/x402/overview

---
title: Overview
sidebarTitle: Overview
description: Pay-per-use browser sessions with USDC on Base and Solana. No API key needed.
llm: true
---
### Overview

The x402 Integration enables pay-per-use browser sessions powered by cryptocurrency. Built on the x402 protocol, it lets you create and manage Steel sessions by paying with USDC on Base or Solana, with no API keys or accounts required.

Endpoint: https://x402.steel.dev

### How It Works

*   **Step 1: Send Request**: Make a request to the x402 endpoint. The server responds with a 402 Payment Required.

*   **Step 2: Sign Transaction**: Your client constructs and signs a payment authorization via a wallet for the requested amount.

*   **Step 3: Pay & Get Data **: Resend the request with the signed payment header and receive your data with a 200 OK response.

### Pricing

Rate: $0.10/hour

### Requirements

*   **Wallet**: Base or Solana wallet with USDC.

### Supported Tokens and Networks

| Network                | USDC Contract Address                             |
|------------------------|---------------------------------------------------|
| Base (mainnet)         | **0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913**    |
| Solana (mainnet)       | **EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v**  |

### Additional Resources

*   [x402 Protocol](https://www.x402.org/) - Learn more about the x402 protocol.

*   [Steel Sessions API Reference](/api-reference) - Technical details for managing Steel browser sessions

*   [Community Discord](https://discord.gg/steel-dev) - Get help and share your implementations

# Overview
URL: /overview/captchas-api/overview

---
title: Overview
sidebarTitle: Overview
description: Automatically detect and solve CAPTCHAs in browser sessions using Steel's integrated captcha solvers and the CAPTCHAs API.
full: true
llm: true
---

Steel's CAPTCHA system is designed to work seamlessly with browser automation workflows, automatically detecting and solving CAPTCHAs without interrupting your automation flow.

Steel's CAPTCHAs API provides a robust solution for handling CAPTCHAs that appear during your automations. The system uses a bridge architecture that connects browser sessions with our CAPTCHA-solving capabilities, enabling real-time detection, solving, and state management.

CAPTCHA solving is particularly useful for:

*   Scraping jobs that encounter CAPTCHA challenges

*   Browser workflows that need to submit forms or handle authentication flows

*   AI agents that need to navigate CAPTCHA-protected websites


### Session Configuration

To enable autosolving, simply set `solveCaptcha: true` when creating a session.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

const session = await client.sessions.create({
  solveCaptcha: true
});
```

```python !! Python -wcn
from steel import Steel

client = Steel()
session = client.sessions.create(
    solve_captcha=True
)
```
</CodeTabs>

To detect CAPTCHAs without automatically solving them, disable `autoCaptchaSolving` in the stealth config:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const session = await client.sessions.create({
  solveCaptcha: true,
  stealthConfig: {
    autoCaptchaSolving: false
  }
});
```

```python !! Python -wcn
session = client.sessions.create(
    solve_captcha=True,
    stealth_config={
        "autoCaptchaSolving": False
    }
)
```
</CodeTabs>


### How CAPTCHA Solving Works with the CAPTCHAs API

Steel's CAPTCHAs API operates through a bridge architecture that connects your browser sessions with our external CAPTCHA-solving capabilities. It helps with four key parts:

1.  **Detection**: The system automatically detects when CAPTCHAs appear on pages

2.  **State Management**: CAPTCHA states are tracked per page with real-time updates

3.  **Solving**: CAPTCHAs are then solved by us using various methods

4.  **Completion**: The system reports back when CAPTCHAs are solved or failed


### Getting CAPTCHA Status

You can check the current CAPTCHA status for any session to understand what CAPTCHAs are active and their current solving progress.


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

const response = await client.sessions.captchas.status('sessionId');

console.log(response);
```

```python !! Python -wcn
from steel import Steel

client = Steel()
response = client.sessions.captchas.status(
    "sessionId",
)
print(response)
```
</CodeTabs>

#### Response Format

The status endpoint returns an array of current pages and their CAPTCHA states. An example output might look like:

```json JSON
[
   {
      "pageId":"page_12345",
      "url":"https://example.com/login",
      "isSolvingCaptcha":true,
      "tasks":[
         {
            "id":"task_67890",
            "type":"image_to_text",
            "status":"solving",
            "created":1640995200000,
            "url":"https://example.com/login",
            "pageId":"page_12345",
            "detectionTime":1640995200500,
            "totalDuration":5000,
            "solveTime":1640995205500
         }
      ],
      "created":1640995200000,
      "lastUpdated":1640995205500
   }
]
```

#### CAPTCHA Task Status

Tasks can have the following statuses:

*   `undetected`: CAPTCHA has not been detected

*   `detected`: CAPTCHA has been detected but solving hasn't started

*   `validating`: CAPTCHA is currently being validated

*   `validation_failed`: CAPTCHA token failed validation after submission

*   `solving`: CAPTCHA is currently being solved

*   `solved`: CAPTCHA has been successfully solved

*   `failed_to_detect`: CAPTCHA detection failed

*   `failed_to_solve`: CAPTCHA solving failed


### Manual Solving

If auto-solving is disabled, use the solve endpoint to trigger solving. You can solve all detected CAPTCHAs or target specific ones.

The `taskId`, `url`, and `pageId` required for targeting specific CAPTCHAs can be retrieved from the CAPTCHA status response. When using `taskId`, use the value from the task's `id` field.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Solve all detected CAPTCHAs
await client.sessions.captchas.solve('sessionId');

// Solve specific task
await client.sessions.captchas.solve('sessionId', { taskId: 'task_123' });

// Solve by URL
await client.sessions.captchas.solve('sessionId', { url: 'https://example.com' });

// Solve by Page ID
await client.sessions.captchas.solve('sessionId', { pageId: 'page_123' });
```

```python !! Python -wcn
# Solve all detected CAPTCHAs
client.sessions.captchas.solve("sessionId")

# Solve specific task
client.sessions.captchas.solve("sessionId", task_id="task_123")

# Solve by URL
client.sessions.captchas.solve("sessionId", url="https://example.com")

# Solve by Page ID
client.sessions.captchas.solve("sessionId", page_id="page_123")
```
</CodeTabs>


### Solving Image CAPTCHAs

For image-based CAPTCHAs, you can provide XPath selectors to help the system locate and solve the CAPTCHA.

The `url` parameter is optional and defaults to the current page.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

const response = await client.sessions.captchas.solveImage('sessionId', {
  imageXPath: '//img[@id="captcha-image"]',
  inputXPath: '//input[@name="captcha"]',
});

console.log(response.success);
```

```python !! Python -wcn
from steel import Steel

client = Steel()
response = client.sessions.captchas.solve_image(
    session_id=session.id,
    image_x_path='//img[@id="captcha-image"]',
    input_x_path='//input[@name="captcha"]',
)
print(response.success)
```
</CodeTabs>

#### Parameters

*   `imageXPath` (required): XPath selector for the CAPTCHA image element

*   `inputXPath` (required): XPath selector for the CAPTCHA input field

*   `url` (optional): URL where the CAPTCHA is located (defaults to current page)


#### Response

```json JSON
{
	"success": true,
	"message": "Image captcha solve request sent"
}
```


### WebSocket Bridge

The CAPTCHA bridge uses WebSocket connections to maintain real-time communication between browser sessions and CAPTCHA-solving extensions. This enables:

*   **Real-time state updates**: Immediate notification when CAPTCHAs are detected or solved

*   **Bidirectional communication**: Extensions can send updates and receive solve requests

*   **Persistent connections**: Maintains connection throughout the session lifecycle


### State Management

The CAPTCHA bridge uses intelligent state management to handle complex scenarios:

#### Page-Based Tracking

States are tracked by `pageId` rather than URL to avoid duplicates and handle dynamic URLs effectively.

#### Task Merging

When multiple updates occur for the same CAPTCHA task, the system intelligently merges the information, preserving important details like:

*   Creation and detection timestamps

*   Solving duration calculations

*   Status progression


#### Duration Calculation

The system automatically calculates task durations based on:

*   `created` or `detectedTime`: When the CAPTCHA was first detected

*   `solveTime` or `failureTime`: When the CAPTCHA was solved or failed

*   Real-time updates during the solving process


### Integrating with Existing Automations

Steel's CAPTCHA system is designed to work seamlessly with your existing automations using Playwright/Puppeteer:

#### Monitoring CAPTCHA Progress

```typescript Typescript -wcn -f captcha.ts
async function waitForCaptchaSolution(sessionId, timeout = 30000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const status = await getCaptchaStatus(sessionId);

    const activeCaptchas = status.filter(state => state.isSolvingCaptcha);

    if (activeCaptchas.length === 0) {
      console.log('All CAPTCHAs solved!');
      return true;
    }

    // Log progress
    activeCaptchas.forEach(captcha => {
      console.log(`CAPTCHA on ${captcha.url}: ${captcha.tasks.length} tasks`);
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('CAPTCHA solving timeout');
}
```


#### Basic Integration Pattern

```typescript Typescript -wcn -f main.ts
// Navigate to a page that might have CAPTCHAs
await page.goto('https://example.com/protected-page');

// Check if CAPTCHAs are present
const captchaStatus = await checkCaptchaStatus(sessionId);

if (captchaStatus.some(state => state.isSolvingCaptcha)) {
  // Wait for CAPTCHA to be solved
  await waitForCaptchaSolution(sessionId);
}

// Continue with automation
await page.click('#submit-button');
```


#### Handling Different CAPTCHA Types

The CAPTCHA bridge automatically handles most common CAPTCHA types. For image CAPTCHAs, you can use the image solving endpoint with specific XPath selectors.

The captcha types for each task are mapped to the CAPTCHA types we support like so:

*   `recaptchaV2`: Google's reCAPTCHA v2 with "I'm not a robot" checkbox and image challenges

*   `recaptchaV3`: Google's reCAPTCHA v3 with invisible background scoring and risk analysis

*   `turnstile`: Cloudflare Turnstile with minimal user interaction verification

*   `image_to_text:` Traditional text-based CAPTCHA requiring OCR of distorted characters


#### Best Practices

1.  **Monitor State Changes**: Regularly check CAPTCHA status during automation

2.  **Handle Timeouts**: Set reasonable timeouts for automatic CAPTCHA solving operations

3.  **Use Specific Selectors**: Provide accurate XPath selectors for image CAPTCHAs

4.  **Error Handling**: Implement proper error handling for failed CAPTCHA attempts

5.  **Logging**: Log CAPTCHA events for debugging and monitoring


The CAPTCHA system is designed to be as transparent as possible to your automation workflows, handling the complexity of CAPTCHA detection and solving while providing you with the control and visibility you need.


:::callout
type: help
### Need help building with the Captchas API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Credentials API
URL: /overview/credentials-api/overview

---
title: Credentials API
sidebarTitle: Overview
description: Programmatic access to stroing credentials for users or agents.
llm: true
---
import Image from 'next/image'

# Overview

Securely store and inject login credentials into browser sessions without exposing them to agents or the page.

:::callout
Steel's Credential system is currently in beta and is subject to improvements, updates, and changes. It will be free to use and store credentials during this period.
If you have feedback, join our Discord or open an issue on GitHub.
:::

Steel's Credentials system is designed to allow developers to securely store credentials, inject them into sessions, and automatically sign-into websites. All without leaking sensitive data back to the agents, programs, or humans viewing a live session.

Some of the most important use-cases for AI agents are hidden behind an auth wall. Some of the data most important to both our work and personal lives live inside sign-in-protected applications. If we want browser agents to help us automate the most tedious aspects of our lives, they need access to those same applications.

The problem is sending your personal credentials (username/passwords, etc) to a browser-agent, powered by an opaque LLM API that may or may not be training on your data, represents a non-trivial security risk. Further, the process of logging in can be error prone and keeping/storing credentials on behalf of users, as an application developer, can represent a ton of responsibility and overhead.

That is the motivation behind Steel's Credentials system. Credentials are stored globally against your organization, so once created, you can reuse them in any session going forward – no need to constantly re-enter or re-provision them.

Steel's Credentials system is built around three core goals:

- Secure storage of credentials using enterprise-grade encryption.
- Controlled injection into browser sessions without exposing sensitive fields.
- Isolation mechanisms to prevent agents from extracting secrets post-injection.

### Table of Contents
- [Getting Started](#getting-started)
- [Injecting Credentials into a Session](#injecting-credentials-into-a-session)
- [TOTP Support](#totp-support)
- [How credentials are injected](#how-credentials-are-injected)
- [Envelope encryption](#envelope-encryption)
- [Using with Agent Frameworks](#using-with-agent-frameworks)

## Getting Started
Before credentials can be used in a browser session, they must first be uploaded and stored securely.

:::callout
All credentials are stored globally against your organization. You only need to create them once.
:::

To upload credentials:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.credentials.create({
  origin: "https://app.example.com",
  value: {
    username: "test@example.com",
    password: "password123"
  }
});
```

```python !! Python -wcn
client.credentials.create(
    origin="https://app.example.com",
    value={
        "username": "test@example.com",
        "password": "password123"
    }
)
```
</CodeTabs>

These credentials are encrypted and stored securely within Steel’s credential management service. The `namespace` field helps separate use cases for the same origin and must match the namespace used when creating the session. For more information on how namespaces work [visit the namespace section](#namespaces). You can optionally include a `totpSecret` field if your login flow uses one-time passwords (see [TOTP Support](#totp-support)).

## Injecting Credentials into a Session
When starting a session via `POST /sessions`, you can request credential injection using the optional `credentials` field:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const session = await client.sessions.create({
  namespace: "default",
  credentials: {}
});
```

```python !! Python -wcn
client.sessions.create(
  namespace="default",
  credentials={}
)
```
</CodeTabs>

If the `credentials` object is omitted, no credentials will be injected. If included as an empty object (`credentials: {}`), the default options apply:

```json JSON
{
  "autoSubmit": true,
  "blurFields": true,
  "exactOrigin": true
}
```

- `autoSubmit`: If `true`, the form will automatically submit once filled.

- `blurFields`: If `true`, each filled field is blurred immediately after input, preventing access.

- `exactOrigin`: If `true`, credentials will only inject into pages that match the exact origin.

You can override any of these to suit your use-case. Remember to match the `namespace` with the one used in your credential creation, if omitted, it defaults to `"default"`.

Once the session is active and on the login page, credentials are typically injected within **2 seconds**. If `autoSubmit` is disabled, the agent or user must manually click the login button.

## TOTP Support
Steel supports auto-filling TOTP (Time-based One-Time Passwords). To use this feature, include a `totpSecret` in the `value` object when uploading credentials:

```json JSON
{
  "username": "test@example.com",
  "password": "password123",
  "totpSecret": "JBSWY3DPEHPK3PXP"
}
```

The secret is securely stored and never exposed to the page. When a one-time password field is detected, Steel generates a valid code on-demand and injects it directly.

## How Credentials are Injected
The system is responsible for securely retrieving and injecting them into service webpages. This happens through a general background communication layer that connects to a secure credential service.

### Overview: how the service fills credentials in a page
1. The credential service loads a lightweight script into each active page and frame.

2. On startup, it watches for forms or login components using mutation observers and shadow DOM traversal.

3. When a valid credential target is detected, it is validated and ranked.

4. The top-ranked candidate is selected as the active target.

5. Observers are attached to the relevant input fields and forms.

6. The credential service requests credentials matching the current org, namespace, and target origin.

7. Once decrypted, credentials are injected directly into the selected form fields.

8. Inputs are updated programmatically, preserving synthetic events and page behavior.
    1. We detect and only inject credentials into a username, password, and one-time password field. The username field is generic and we try our best to map any identifier to this property (email, identifier, username, etc.).
    2. inputs are blurred once a value is inserted (configurable) to prevent vision agents from reading PII

9. The form is submitted either natively or via simulated interaction, depending on the form structure if autoSubmit is configured.

10. Updates to the DOM are continuously monitored to adapt to dynamic changes in the page.

## Envelope encryption
Envelope encryption is a secure and scalable pattern where data is encrypted using a randomly generated data key (usually with a symmetric algorithm like AES), and that data key is then encrypted with a master key managed by a key management store (KMS).

Each credential is protected with its own short‑lived AES‑256‑GCM key. The key is then encrypted with a private KMS key specific to an organization. The encrypted data and the encrypted key travel together.

<Image src="/images/x6qu00vtJfpmIZk6aXJZI.png" width={800} height={500}/>


At decryption time, the inverse happens where we then get the encrypted AES key, decrypt it using the specific key pair for the KMS and then use this decrypted AES key to decrypt the credential. The clear-text credentials are placed directly into the in-memory session and sent to the target service over our private WireGuard backbone ensuring end-to-end encryption and safe keeping of your credentials.
<Image src="/images/t61KyxNNN0LQhh_DqvYjp.png" width={800} height={500}/>

#### Additional authenticated data (AAD)
We bind the cipher-text to its context by including the org ID and credential origin as AAD. A mismatch during decrypt causes the operation to fail which blocks replay attacks across orgs.

## Namespaces
Namespaces allow you to differentiate between multiple credentials for the same origin. This is useful when you need to store and use separate login details for different users or use cases.

By default, all credentials and sessions are created under the `default` namespace. If you don’t specify a namespace, this is what will be used.

#### Why Use Namespaces?
If you have multiple credentials for the same website, namespaces help you control which one is used in a given session.

For example, say you have two users who log in to the same domain:

```json JSON
// Credential A
{
  "namespace": "example:fred",
  "origin": "https://app.example.com",
  "value": {
    "username": "fred@example.com",
    "password": "hunter2"
  }
}

// Credential B
{
  "namespace": "example:jane",
  "origin": "https://app.example.com",
  "value": {
    "username": "jane@example.com",
    "password": "letmein"
  }
}
```

To use **Fred’s** credentials in a session:

```json JSON
POST /sessions
{
  "namespace": "example:fred",
  "credentials": {}
}
```

This ensures only the credentials created under `example:fred` will be injected.

#### Best Practices
- Use simple, descriptive namespaces like `example:fred` or `test:jane`.

- Stick to a consistent pattern (e.g., `org:user`) for better organization.

- Always match the `namespace` in your session with the one used to create the credentials.

:::callout
Namespace matching is exact. There is no inheritance or wildcard matching—only credentials in the exact namespace provided will be used.
:::

## Using with Agent Frameworks
Steel is designed to integrate seamlessly with browser automation tools and agent frameworks such as `browser-use` and similar libraries.

While we don’t yet expose framework-specific SDKs or utilities, the process is straightforward and works out of the box with minimal setup.

#### How it Works
Once credentials are linked to your session, injection and login will occur automatically as part of the page lifecycle. To make use of this in your agent or script, follow this basic pattern:

1. **Navigate** to the login page of the target website.

2. **Wait** at least 2 seconds to allow Steel to detect and fill the form.

3. **Continue** once logged in.

If `autoSubmit` is enabled (which it is by default), the login form will be submitted automatically once the fields are populated and validated.

If `autoSubmit` is disabled, you must explicitly trigger the login action (e.g., click the login button) after credentials are filled.

#### Example Flow

```typescript Typescript -wcn -f main.ts
await page.goto("https://app.example.com/login");

// Optional: ensure login form is present
await page.waitForSelector("form");

// Wait for Steel to inject and (optionally) submit the form
await page.waitForTimeout(2000);

// Recommended: confirm login succeeded
await page.waitForSelector(".dashboard"); // or some element/text that confirms login
```

#### Notes
- Credential injection is bound to the session's namespace and the origin provided when the credential was created.

- Injection will only occur on exact origins if `exactOrigin: true` (default).

- The page must be fully loaded and interactive for injection to proceed reliably.

We plan to release official helpers and utilities for common frameworks like `browser-use`, `Playwright`, and `Puppeteer` soon. For now, you can build on this guide to integrate Steel into your existing automation workflows.



:::callout
type: help
### Need help building with the Credentials API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Overview
URL: /overview/extensions-api/overview

---
title: Overview
sidebarTitle: Overview
description: Add Chrome extensions to your Steel sessions.
full: true
llm: true
---
:::callout
Steel’s Extensions system is currently in beta and is subject to improvements, updates, and changes. If you have feedback, join our Discord or open an issue on GitHub.
:::

Steel's extensions are designed to enhance the functionality of Steel sessions by providing additional features and capabilities. These extensions can be used to automate tasks, enhance security, and improve the overall agent experience. They can be installed through the API for your organization and attached to any session.

Extensions have long been a part of the browser ecosystem, since the release of Internet Explorer version 4 in 1997, users have been able to create their own extensions and make their browser their own. With the advent of agentic browsing and browser agents, extensions have gained a whole new light. Allowing thousands of agents to extend their own browser sessions with custom functionality.

### Getting Started

Before extensions can be used in a browser session, they must first be uploaded either with a .zip/.crx file or downloaded from the Chrome Web Store.

All extensions are stored globally against your organization. You only need to upload them once. The supported formats include .zip and .crx

### Upload Extension From File

The extensions uploaded have a couple of requirements. They need a preliminary manifest.json file to define the extension's metadata and functionality. This file should include details such as the extension's name, version, and any permissions required.


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.upload({
    file: fs.readFileSync('extensions/recorder/recorder.zip')
  });
```


```python !! Python -wcn
with open("extensions/recorder/recorder.zip", "rb") as file:
    client.extensions.upload(
        file=file
    )
```
</CodeTabs>


### Upload Extension from Chrome Web Store

Go to the Chrome Web Store and click on the extension you want to upload. Copy the URL and include it in the request below

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.upload({
   url: "https://chromewebstore.google.com/detail/.../..."
});
```


```python !! Python -wcn
client.extensions.upload(
    url="https://chromewebstore.google.com/detail/.../..."
)
```
</CodeTabs>



Once they are installed for your organization, you can inject them into your sessions.

### Injecting Extensions into a Session

You can inject specific extensions into your sessions based on the `extensionId` field or you can pass `all_ext` to inject all extensions from your organization.


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const session = await client.sessions.create({
  extensionIds: ['all_ext'] // extensionIds=['extensionId_1', 'extensionId_2']
});
```


```python !! Python -wcn
client.sessions.create(
    extension_ids=['all_ext'] # extension_ids=['extensionId_1', 'extensionId_2']
)
```
</CodeTabs>


And now your sessions have extensions!

These extensions will be injected into the Steel browser session that then runs with that session. Extensions are loaded and initialized when the session starts. They can communicate with the session using the Chrome DevTools Protocol (CDP) and interact with the browser environment.

### Updating Extensions From File

After using your extensions, you can update them by uploading a new version of the extension. You will need to specify the `extensionId` of the extension you want to update.


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.update("{extensionId}",{
    file: fs.readFileSync("extensions/recorder2/recorder2.zip")
  });
```


```python !! Python -wcn
with open("extensions/recorder2/recorder2.zip", "rb") as file:
    client.extensions.update("{extensionId}",
        file=file
    )
```
</CodeTabs>


### Updating Extensions From Chrome Web Store

You will need to specify the `extensionId` of the extension you want to update

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.update("{extensionId}",{
    url: "https://chromewebstore.google.com/detail/.../..."
});
```


```python !! Python -wcn
client.extensions.update("{extensionId}",
    url="https://chromewebstore.google.com/detail/.../..."
)
```

</CodeTabs>


### Seeing your Extensions

To see your organization's installed extensions, you can use the `GET /v1/extensions` endpoint.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const extensions = await client.extensions.list();
```

```python !! Python -wcn
extensions = client.extensions.list()
```

</CodeTabs>


### Deleting an Extension

To delete one of your organization's installed extensions, you can use the `DELETE /v1/extensions/{extensionId}` endpoint.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.delete("{extensonId}")
```

```python !! Python -wcn
client.extensions.delete("{extensionId}")
```

</CodeTabs>


### Deleting all Extensions

To delete all of your organization's installed extensions, you can use the `DELETE /v1/extensions/` endpoint.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
await client.extensions.deleteAll()
```

```python !! Python -wcn
client.extensions.deleteAll()
```
 </CodeTabs>


 :::callout
 type: help
 ### Need help building with the Extensions API?
 Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
 :::


# Overview
URL: /overview/files-api/overview

---
title: Overview
sidebarTitle: Overview
description: How to upload, download, manage and work with files within an active session
full: true
llm: true
---
import Image from 'next/image'

<Image src="/images/AZtqJmCS-b3Skd0l83dcH.png" alt="Files API Overview" width={1000} height={300} />

Steel provides two complementary file management systems: Session Files for working with files within active browser sessions, and Global Files for persistent file storage across your organization.

### Overview

Steel's file management system makes it easy to work with files in your automated workflows:

*   **Session-Based File Operations**: Upload files to active sessions for immediate use in browser automations, download files acquired during browsing

*   **Persistent File Storage**: Maintain a global file repository for reuse across multiple sessions and workflows

*   **Workspace Management**: Organize and access files generated across different automation runs

*   **Data Pipeline Integration**: Upload datasets once and reference them across multiple automation sessions

*   **File Archival**: Automatically preserve files from completed sessions for later access


### How It Works

#### Session Files System

Files uploaded to active sessions become available within that session's isolated VM environment. These files can be used immediately with web applications and browser automation tools. When files are downloaded from the internet during a session, they become accessible through the same API. Session files persist beyond session lifecycle - files are automatically backed up when sessions end.

#### Global Files System

The Global Files API provides persistent, organization-wide file storage independent of browser sessions. Files uploaded to global storage can be referenced and mounted in any session. All session files are automatically promoted to global storage when sessions are released, creating a comprehensive file workspace.

### Session Files API

This section outlines how to interact with the filesystem inside of the VM that your session is running from. All of these files are accessible from the browser.

#### Upload Files to Session File System

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Upload file to session environment
const file = fs.createReadStream("./steel.png");
const session = await client.sessions.create();
const uploadedFile = await client.sessions.files.upload(session.id, {
  file: file, // or path in global files api or absolute url
});
```

```python !! Python -wcn
import requests

session_id = "YOUR_SESSION_ID"
api_key = "YOUR_API_KEY_HERE"
file_path = "./steel.png"

with open(file_path, "rb") as f:
    response = requests.post(
        f"https://api.steel.dev/v1/sessions/{session_id}/files/upload",
        headers={"steel-api-key": api_key},
        files={"file": f}
    )
print(response.json())
```
</CodeTabs>


#### List Files in a Session File System

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const files = await client.session.files.list(sessionId);
files.forEach(file => {
  console.log(`${file.path} | Size: ${file.size} | Last Modified: ${file.lastModified}`);
});
```

```python !! Python -wcn
import requests

session_id = "YOUR_SESSION_ID"
api_key = "YOUR_API_KEY_HERE"

response = requests.get(
    f"https://api.steel.dev/v1/sessions/{session_id}/files",
    headers={"steel-api-key": api_key}
)
for file in response.json():
    print(f"{file['path']} | Size: {file['size']} | Last Modified: {file['lastModified']}")
```
</CodeTabs>


#### Download Files from Session File System

<CodeTabs storage="languageSwitcher">


```typescript !! Typescript -wcn
// Download a specific file from a session
const response = await client.sessions.files.download(sessionId, "path/to/file");
const fileBlob = await response.blob();

// Download all files as zip archive
const archiveResponse = await client.sessions.files.downloadArchive(sessionId);
```

```python !! Python -wcn
import requests

session_id = "YOUR_SESSION_ID"
api_key = "YOUR_API_KEY_HERE"

# Download a specific file
file_resp = requests.get(
    f"https://api.steel.dev/v1/sessions/{session_id}/files/path/to/file",
    headers={"steel-api-key": api_key}
)
with open("downloaded_file", "wb") as f:
    f.write(file_resp.content)

# Download all files as zip archive
archive_resp = requests.get(
    f"https://api.steel.dev/v1/sessions/{session_id}/files/archive",
    headers={"steel-api-key": api_key}
)
with open("session_files.zip", "wb") as f:
    f.write(archive_resp.content)
```
</CodeTabs>


#### Delete Files from Sessions File System

<CodeTabs storage="languageSwitcher">


```typescript !! Typescript -wcn
// Delete a specific file from a session
const response = await client.sessions.files.delete(sessionId, "path/to/file");

// Delete all files in a session
const archiveResponse = await client.sessions.files.deleteAll(session.id);
```

```python !! Python -wcn
import requests

session_id = "YOUR_SESSION_ID"
api_key = "YOUR_API_KEY_HERE"

# Delete a specific file
del_resp = requests.delete(
    f"https://api.steel.dev/v1/sessions/{session_id}/files/path/to/file",
    headers={"steel-api-key": api_key}
)
print(del_resp.status_code)

# Delete all files in a session
del_all_resp = requests.delete(
    f"https://api.steel.dev/v1/sessions/{session_id}/files",
    headers={"steel-api-key": api_key}
)
print(del_all_resp.status_code)
```
</CodeTabs>


### Global Files API

#### Upload File to Global Storage

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const file = fs.createReadStream("./dataset.csv");
const globalFile = await client.files.upload({
    file,
   // path: "dataset.csv" // optional
});
console.log(globalFile.path); // dataset.csv

// Using the file from Global Files API in a session
const session = await client.sessions.create();
const uploadedFile = await client.sessions.files.upload(session.id, {
  file: globalFile.path
});
```

```python !! Python -wcn
import requests

api_key = "YOUR_API_KEY_HERE"
file_path = "./dataset.csv"

with open(file_path, "rb") as f:
    response = requests.post(
        "https://api.steel.dev/v1/files/upload",
        headers={"steel-api-key": api_key},
        files={"file": f}
    )
print(response.json())
```
</CodeTabs>


#### List All Files

<CodeTabs storage="languageSwitcher">


```typescript !! Typescript -wcn
const files = await client.files.list();
files.forEach(file => {
  console.log(`${file.path} | Size: ${file.size} | Last Modified: ${file.lastModified}`);
});
```

```python !! Python -wcn
import requests

api_key = "YOUR_API_KEY_HERE"

response = requests.get(
    "https://api.steel.dev/v1/files",
    headers={"steel-api-key": api_key}
)
for file in response.json():
    print(f"{file['path']} | Size: {file['size']} | Last Modified: {file['lastModified']}")
```
</CodeTabs>


#### Download Global File

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const response = await client.files.download(file.path); // dataset.csv
const fileBlob = await response.blob();
```

```python !! Python -wcn
import requests

api_key = "YOUR_API_KEY_HERE"
file_path = "dataset.csv"

response = requests.get(
    f"https://api.steel.dev/v1/files/{file_path}",
    headers={"steel-api-key": api_key}
)
with open(file_path, "wb") as f:
    f.write(response.content)
```
</CodeTabs>


#### Delete Global File

<CodeTabs storage="languageSwitcher">


```typescript !! Typescript -wcn
await client.files.delete(file.path);
```

```python !! Python -wcn
import requests

api_key = "YOUR_API_KEY_HERE"
file_path = "dataset.csv"

response = requests.delete(
    f"https://api.steel.dev/v1/files/{file_path}",
    headers={"steel-api-key": api_key}
)
print(response.status_code)
```
</CodeTabs>


### Usage in Context

#### Set File Input Values

Reference uploaded files in file input elements using CDP (Chrome DevTools Protocol).

```typescript Typescript -wcn -f main.ts
// Create CDP session for advanced controls
const cdpSession = await currentContext.newCDPSession(page);
const document = await cdpSession.send("DOM.getDocument");

// Find the input element
const inputNode = await cdpSession.send("DOM.querySelector", {
  nodeId: document.root.nodeId,
  selector: "#file-input"
});

// Set the uploaded file as input
await cdpSession.send("DOM.setFileInputFiles", {
  files: [uploadedSessionFile.path],
  nodeId: inputNode.nodeId,
});

```


#### Standard Playwright/Puppeteer Upload

```typescript Typescript -wcn -f main.ts
// For simple/smaller file uploads,
// using standard automation library methods will look at local files
await page.setInputFiles("#file-input", [uploadedSessionFile.path]);
```


#### Browser-Use Example

Browser-use needs some setup before it can be used. This includes setting up the browser profile with the correct downloads path and adding in a step hook to extract downloaded files to your local machine if necessary.

```python Python -wcn -f main.py
# Before agent main loop...

# Hook to extract downloaded files to local machine if necessary
async def step_hook_start(agent):
    if os.environ.get("BROWSER_PROVIDER") == "steel":
        await agent._check_and_update_downloads()
        if agent.available_file_paths and len(agent.available_file_paths) > 0:
            has_new_files = False
            for file_path in agent.available_file_paths:
                if file_path not in downloaded_files:
                    downloaded_files.append(file_path)
                    has_new_files = True
            if has_new_files:
                try:
                    extracted_files = await browser_service.extract_downloaded_files(DOWNLOAD_PATH)
                    logger.info(f"Extracted files: {extracted_files}")
                except Exception as e:
                    logger.error(f"Failed to extract downloaded files: {e}")

async def main():
    try:
        browser_session = Browser(cdp_url=cdp_url, downloads_path="/files")
        await browser_session.connect()
        await browser_session.cdp_client.send.Target.createBrowserContext()
        browser_context_ids_return = await browser_session.cdp_client.send.Target.getBrowserContexts()
        browser_context_ids = browser_context_ids_return['browserContextIds']
        browser_context_id = browser_context_ids[0]
        await browser_session.cdp_client.send.Browser.setDownloadBehavior(params={"behavior": "allow", "downloadPath": "/files", "eventsEnabled": True, "browserContextId": browser_context_id})
        agent = Agent(task=TASK, llm=model, browser_session=browser_session)
        agent.browser_session.browser_profile.downloads_path = LOCAL_DOWNLOAD_PATH
        agent_results = await agent.run(
            on_step_start=step_hook_start,
            max_steps=5
        )
    except Exception as e:
        print(f"Error: {e}")
    finally:
        # Clean up resources
        if session:
            client.sessions.release(session.id)
            print("Session released")
        print("Done!")
# Rest of code...
```


#### Complete Example

End-to-end workflow demonstrating global file management and session file operations.

```typescript Typescript -wcn -f main.ts
import dotenv from "dotenv";
import fs from "fs";
import { chromium } from "playwright";
import Steel from "steel-sdk";

dotenv.config();

const client = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

async function main() {
  let session;
  let browser;

  try {
    // Upload dataset to global storage for reuse
    const datasetFile = new File(
      [fs.readFileSync("./data/stock-data.csv")],
      "stock-data.csv",
      { type: "text/csv" }
    );

    const globalFile = await client.files.upload({ file: datasetFile });
    console.log(`Dataset uploaded to global storage: ${globalFile.id}`);

    // Create session and mount global file
    session = await client.sessions.create();
    console.log(`Session created: ${session.sessionViewerUrl}`);

    const sessionFile = await client.sessions.files.upload(session.id, {
      file: globalFile.path
    });

    // Connect browser and use the file
    browser = await chromium.connectOverCDP(
      `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
    );

    const currentContext = browser.contexts()[0];
    const page = currentContext.pages()[0];

    // Navigate to data visualization tool
    await page.goto("<https://www.csvplot.com/>");

    // Upload file to web application using CDP
    const cdpSession = await currentContext.newCDPSession(page);
    const document = await cdpSession.send("DOM.getDocument");
    const inputNode = await cdpSession.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector: "#load-file",
    });

    await cdpSession.send("DOM.setFileInputFiles", {
      files: [sessionFile.path],
      nodeId: inputNode.nodeId,
    });

    // Wait for visualization and capture
    await page.waitForSelector("svg.main-svg");

    // Download all session files (original upload + any generated files)
    const archiveResponse = await client.sessions.files.download.archive(session.id);
    const zipBlob = await archiveResponse.blob();

    // Files are automatically available in global storage after session ends

  } catch (error) {
    console.error("Error:", error);
  } finally {
    if (browser) await browser.close();
    if (session) await client.sessions.release(session.id);

    // List all available files in global storage
    const allFiles = await client.files.list();
    console.log(`Total files in storage: ${allFiles.length}`);
  }
}

main();
```


:::callout
type: help
### Need help building with the Files API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Connect with Playwright (Node)
URL: /overview/guides/playwright-node

---
title: Connect with Playwright (Node)
description: Drive a Steel session with Playwright via WebSocket connection
sidebarTitle: Connect with Playwright (Node)
llm: true
---

This guide shows you how to drive Steel's cloud browser sessions using Playwright with Node.js/TypeScript. Looking for Python? Check out our [Playwright Python guide](link-to-python-guide).

Steel sessions are designed to be easily driven by Playwright. There are two main methods for connecting to & driving a Steel session with Playwright.



**Quick Start:** Want to jump right in? [Skip to example project](https://docs.steel.dev/overview/guides/connect-with-playwright-node#example-project-scraping-hacker-news).

Method #1: One-line change (_easiest)_
--------------------------------------

Most Playwright scripts start with `chromium.launch()` function to launch your browser with desired args that looks something like this:
```typescript Typescript -wcn
const browser = await chromium.launch({...});
```



Simply change this line to the following (replacing `MY_STEEL_API_KEY` with your api key):
```typescript Typescript -wcn
const browser = await chromium.connectOverCDP(
    'wss://connect.steel.dev?apiKey=MY_STEEL_API_KEY'
);
```



**_and voila!_** This will automatically start and connect to a Steel session for you with all default parameters set. Your subsequent calls will work as they did previously.

When you're done, the session automatically releases when your script calls `browser.close()`, `browser.disconnect()`, or ends the connection.



#### **Advanced: Custom Session IDs**

This doesn’t support other UTM parameters to add args (that is what Method #2 is for) other than one - `sessionId`. This allows you to set a custom session id (UUIDv4 format) for the session.

This is helpful because you don’t get any data returned from connecting like this but by setting your own session ID, you can use the API/SDKs to retrieve data or taking actions on the session like manually releasing it.

Example:
```typescript Typescript -wcn
import { v4 as uuidv4 } from 'uuid';
import Steel from 'steel-sdk';

const sessionId = uuidv4(); // '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${sessionId}`
);

// Get session details
const client = new Steel();
const session = await client.sessions.retrieve(sessionId);
console.log(`View session live at: ${session.sessionViewerUrl}`);
```



Method #2: Create and connect
-----------------------------

Use this method when you need to drive a session with non-default features like proxy support or CAPTCHA solving. The main difference is that you'll:

*   Start a session via API

*   Connect to it via chromium.connectOverCDP()

*   Release the session when finished


If you want your session to be recorded in the live viewer make sure to use the existing browser context from the session when controlling a page as opposed to creating a new context.
```typescript Typescript -wcn
import Steel from 'steel-sdk';
import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

const client = new Steel({
    steelAPIKey: process.env.STEEL_API_KEY,
});

async function main() {
    // Create a session with additional features
    const session = await client.sessions.create({
        useProxy: true,
        solveCaptcha: true,
    });

    // Connect with Playwright
    const browser = await chromium.connectOverCDP(
        `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
    );

    // Create page at existing context to ensure session is recorded. This is crucial!
    const currentContext = browser.contexts()[0];
    const page = await currentContext.pages()[0];

    // Run your automation
    await page.goto('https://example.com');

    // Always clean up when done
    await browser.close();
    await client.sessions.release(session.id);
}

main();
```



**Important**: With Method #2, sessions remain active until explicitly released or timed out. It’s best practise to call `client.sessions.release()` when finished instead of waiting for the session to timeout to be released.



Example Project: Scraping Hacker News
-------------------------------------

Here's a working example that scrapes Hacker News with proper error handling and session management:

Starter code that scrapes Hacker News for top 5 stories using Steel's Node SDK and Playwright.



Run by entering following commands in the terminal:

*   `export STEEL_API_KEY=your_api_key`

*   `npm start`


The example includes:

*   Complete session configuration options

*   Error handling best practices

*   A working Hacker News scraper example

*   TypeScript support


You can also clone it on [Github](https://github.com/steel-dev/steel-cookbook/blob/main/examples/steel-playwright-starter), [StackBlitz](https://stackblitz.com/edit/steel-playwright-starter?file=README.md), or [Replit](https://replit.com/@steel-dev/steel-playwright-starter?v=1) to start editing it yourself!


# Connect with Playwright (Python)
URL: /overview/guides/playwright-python

---
title: Connect with Playwright (Python)
description: Drive a Steel session with Playwright-python via WebSocket connection
sidebarTitle: Connect with Playwright (Python)
llm: true
---


This guide shows you how to drive Steel's cloud browser sessions using Playwright with Python. Looking for Node.js/TypeScript? Check out our [Playwright Node.js guide](link-to-node-guide).

Steel sessions are designed to be easily driven by Playwright. There are two main methods for connecting to & driving a Steel session with Playwright.



Quick Start: Want to jump right in? [Skip to example project](https://docs.steel.dev/overview/guides/connect-with-playwright-python#example-project-scraping-hacker-news).

Method #1: One-line change (_easiest)_
--------------------------------------

Most Playwright scripts start with `chromium.launch()` function to launch your browser with desired args that looks something like this:
```python Python -wcn
browser = chromium.launch()
```



Simply change this line to the following (replacing `MY_STEEL_API_KEY` with your api key):
```python Python -wcn
browser = chromium.connect_over_cdp(
    'wss://connect.steel.dev?apiKey=MY_STEEL_API_KEY'
)
```



**_and voila!_** This will automatically start and connect to a Steel session for you with all default parameters set. Your subsequent calls will work as they did previously.

When you're done, the session automatically releases when your script calls `browser.close()`, `browser.disconnect()`, or ends the connection.



#### **Advanced: Custom Session IDs**

This doesn’t support other UTM parameters to add args (that is what Method #2 is for) other than one - `sessionId`. This allows you to set a custom session id (UUIDv4 format) for the session.

This is helpful because you don’t get any data returned from connecting like this but by setting your own session ID, you can use the API/SDKs to retrieve data or taking actions on the session like manually releasing it.

Example:
```python Python  -wcn
from uuid import uuid4
from playwright.sync_api import sync_playwright

session_id = str(uuid4())  # '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp(
    f'wss://connect.steel.dev?apiKey={os.getenv("STEEL_API_KEY")}&sessionId={session_id}'
)
```



Method #2: Create and connect
-----------------------------

Use this method when you need to drive a session with non-default features like proxy support or CAPTCHA solving. The main difference is that you'll:

*   Start a session via API

*   Connect to it via chromium.connect\_over\_cdp()

*   Release the session when finished


If you want your session to be recorded in the live viewer make sure to use the existing browser context from the session when controlling a page as opposed to creating a new context.
```python Python -wcn
import os
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from steel import Steel

load_dotenv()

client = Steel(
    steel_api_key=os.getenv('STEEL_API_KEY'),
)

def main():
    # Create a session with additional features
    session = client.sessions.create(
        use_proxy=True,
        solve_captcha=True,
    )

    # Connect with Playwright
    playwright = sync_playwright().start()
    browser = playwright.chromium.connect_over_cdp(
        f'wss://connect.steel.dev?apiKey={os.getenv("STEEL_API_KEY")}&sessionId={session.id}'
    )

    # Create page at existing context to ensure session is recorded.
    currentContext = browser.contexts[0]
    page = currentContext.new_page()

    # Run your automation
    page.goto('https://example.com')

    # Always clean up when done
    browser.close()
    client.sessions.release(session.id)

if __name__ == "__main__":
    main()
```


**Important**: With Method #2, sessions remain active until explicitly released or timed out. It’s best practise to call `client.sessions.release()` when finished instead of waiting for the session to timeout to be released.



Example Project: Scraping Hacker News
-------------------------------------

Here's a working example that scrapes Hacker News with proper error handling and session management:

Starter code that scrapes Hacker News for top 5 stories using Steel's Python SDK and Playwright.



To run it:

*   Add your `STEEL_API_KEY` to the secrets pane. It's located under "Tools" on the left hand pane.

*   Hit Run


The example includes:

*   Complete session configuration options

*   Error handling best practices

*   A working Hacker News scraper example


You can also clone it on [Github](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-playwright-python-starter) [](https://github.com/steel-dev/steel-puppeteer-starter)or [Replit](https://replit.com/@steel-dev/steel-playwright-python-starter?v=1) to start editing it yourself!


# Connect with Puppeteer
URL: /overview/guides/puppeteer

---
title: Connect with Puppeteer
description: Drive a Steel session with Puppeteer via WebSocket connection
sidebarTitle: Connect with Puppeteer
llm: true
---

This guide shows you how to drive Steel's cloud browser sessions using Puppeteer.

Steel sessions are designed to be easily driven by Puppeteer. There are two main methods for connecting to & driving a Steel session with Puppeteer.



**Quick Start**: Want to jump right in? [Skip to example project.](#example-project-scraping-hacker-news)

Method #1: One-line change (_easiest)_
--------------------------------------

Most Puppeteer scripts start with a `puppeteer.launch()` function to launch your browser with desired args that looks something like this:
```typescript Typescript -wcn
const browser = await puppeteer.launch({...});
```



Simply change this line to the following (replacing `MY_STEEL_API_KEY` with your api key):
```typescript Typescript -wcn
const browser = await puppeteer.connect({
    browserWSEndpoint: 'wss://connect.steel.dev?apiKey=MY_STEEL_API_KEY',
});
```



**_and voila!_** This will automatically start and connect to a Steel session for you with all default parameters set. Your subsequent calls will work as they did previously.

When you're done, the session automatically releases when your script calls `browser.close()`, `browser.disconnect()`, or ends the connection.



**Advanced: Custom Session IDs**

This doesn’t support other UTM parameters to add args (that is what Method #2 is for) other than one - `sessionId`. This allows you to set a custom session id (UUIDv4 format) for the session.

This is helpful because you don’t get any data returned from connecting like this but by setting your own session ID, you can use the API/SDKs to retrieve data or taking actions on the session like manually releasing it.

Example:
```typescript Typescript -wcn
import { v4 as uuidv4 } from 'uuid';
import Steel from 'steel-sdk';

const sessionId = uuidv4(); // '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${sessionId}`,
});

// Get session details
const client = new Steel();
const session = await client.sessions.retrieve(sessionId);
console.log(`View session live at: ${session.sessionViewerUrl}`);
```



Method #2: Create and connect
-----------------------------

Use this method when you need to drive a session with non-default features like proxy support or CAPTCHA solving. The main difference is that you'll:

*   Start a session via API

*   Connect to it via puppeteer.connect()

*   Release the session when finished
```typescript Typescript -wcn
import Steel from 'steel-sdk';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const client = new Steel({
    steelAPIKey: process.env.STEEL_API_KEY, // Optional
});

async function main() {
    // Create a session with additional features
    const session = await client.sessions.create({
        useProxy: true,
        solveCaptcha: true,
    });

    // Connect with Puppeteer
    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`,
    });

    // Run your automation
    const page = await browser.newPage();
    await page.goto('https://example.com');

    // Always clean up when done
    await browser.close();
    await client.sessions.release(session.id);
}

main();
```



**Important**: With Method #2, sessions remain active until explicitly released or timed out. It’s best practise to call `client.sessions.release()` when finished instead of waiting for the session to timeout to be released.



Example Project: Scraping Hacker News
-------------------------------------

Here's a working example that scrapes Hacker News with proper error handling and session management:

Starter code that scrapes Hacker News for top 5 stories using Steel's Node SDK and Puppeteer.



Run by entering following commands in the terminal:

*   `export STEEL_API_KEY=your_api_key`

*   `npm start`


The example includes:

*   Complete session configuration options

*   Error handling best practices

*   A working Hacker News scraper example

*   TypeScript support


You can also clone it on [Github](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-puppeteer-starter), [Val.town](https://www.val.town/v/stevekrouse/steel_puppeteer_starter), [StackBlitz](https://stackblitz.com/edit/steel-puppeteer-starter?file=README.md), or [Replit](https://replit.com/@steel-dev/steel-puppeteer-starter?v=1) to start editing it yourself!


# Connect with Selenium
URL: /overview/guides/selenium

---
title: Connect with Selenium
description: How to drive and connect to Steel browser sessions with Selenium
sidebarTitle: Connect with Selenium
llm: true
---


Our Selenium integration is in its early stages and is not at feature parity with our Puppeteer and Playwright integrations. Some features like CAPTCHA solving and proxy support are currently unavailable. More details are provided below.

Steel sessions are designed to be easily driven by Selenium, allowing you to run your existing Selenium scripts in the cloud with minimal changes.

This guide shows you how to drive Steel's cloud browser sessions using Selenium with Python.

Quick Start: Want to jump right in? [Skip to example project.](https://docs.steel.dev/overview/guides/connect-with-selenium#example-project-scraping-hacker-news)

Limitations
-----------

Before we begin, please note that the following features are not yet supported in our Selenium integration:

*   **CAPTCHA Solving:** Automatic CAPTCHA solving is not available.

*   **Proxy Support:** Custom proxy configurations are currently unsupported.

*   **Advanced Session Management:** Features like session cloning and cookie manipulation are limited.

*   **Live Session Viewer:** While sessions are logged in the Steel Cloud app, we don’t currently have support for the live session viewer.




Connecting to Steel with Selenium
---------------------------------

Most Selenium scripts start with a simple WebDriver setup that looks something like this:
```python Python -wcn
from selenium import webdriver

driver = webdriver.Chrome()  # or Firefox(), Safari(), etc.
driver.get('https://example.com')
```

To run your script with Steel, you'll need to:

*   Create a session with Selenium support enabled

*   Set up custom header handling (required for authentication)

*   Connect using Steel's dedicated Selenium URL


#### Here's what that looks like:

First, create a custom connection handler for Steel-specific headers:

```python Python -wcn
from selenium.webdriver.remote.remote_connection import RemoteConnection

class CustomRemoteConnection(RemoteConnection):
    def __init__(self, remote_server_addr: str, session_id: str):
        super().__init__(remote_server_addr)
        self._session_id = session_id

    def get_remote_connection_headers(self, parsed_url, keep_alive=False):
        headers = super().get_remote_connection_headers(parsed_url, keep_alive)
        headers.update({
            'steel-api-key': os.environ.get("STEEL_API_KEY"),
            'session-id': self._session_id
        })
        return headers

```




Then use it to connect to Steel:

```python Python -wcn
from steel import Steel
from selenium import webdriver
import os

client = Steel(
    steel_api_key=os.getenv('STEEL_API_KEY'),
)

def main():
    # Create a session with Selenium support
    session = client.sessions.create(
        is_selenium=True,  # Required for Selenium sessions
    )

    # Connect using the custom connection handler
    driver = webdriver.Remote(
        command_executor=CustomRemoteConnection(
            remote_server_addr='http://connect.steelbrowser.com/selenium',
            session_id=session.id
        ),
        options=webdriver.ChromeOptions()
    )

    # Run your automation
    driver.get('https://example.com')

    # Clean up when done
    driver.quit()
    client.sessions.release(session.id)

if __name__ == "__main__":
    main()
```

**Important**: Sessions remain active until explicitly released or timed out. It’s best practise to call `client.sessions.release()` when finished instead of relying on timeout.

Why Custom Headers?
-------------------

Unlike Puppeteer and Playwright, Selenium doesn't natively support adding the headers required by Steel (session-id and steel-api-key). That's why we need to create a custom connection handler to include these headers with each request.

Example Project: Scraping Hacker News
-------------------------------------

Here's a working example that scrapes Hacker News with proper error handling and session management:

Starter code that scrapes Hacker News for top 5 stories using Steel's Python SDK and Selenium.



To run it:

*   Add your `STEEL_API_KEY` to the secrets pane. It's located under "Tools" on the left hand pane.

*   Hit Run


The example includes:

*   Complete session configuration options

*   Error handling best practices

*   A working Hacker News scraper example


You can also clone it on [Github](https://github.com/steel-dev/steel-cookbook/tree/main/examples/steel-selenium-starter) or [Replit](https://replit.com/@steel-dev/steel-selenium-starter?v=1#README.md) to start editing it yourself!


# Overview
URL: /overview/profiles-api/overview

---
title: Overview
sidebarTitle: Overview
description: Reuse browser context, auth, cookies, extensions, credentials, and browser settings across sessions.
full: true
llm: true
---
### Overview

Steel's profiles API allows you to create, update, and persist profiles across sessions. Profiles are used to store information about the browser session like auth, cookies, extensions, credentials, and browser settings.

Then you can keep reusing profiles across sessions for each different use case. Think a LinkedIn profile, a GitHub profile, or a Facebook profile.

This allows your agents to look more human, persist everything across sessions and frees you to focus on the most important part of your workflow.

### Limits
- There is a 300 MB limit on the size of a profile, if the upload fails after a session, the profile will be set to a `FAILED` state and cannot be used
- If a profile is not used after 30 days, it will be automatically deleted

### How Profiles Work

Profiles work by storing a snapshot of the browser's User Data Directory. This includes all the data that is stored in the browser, such as cookies, extensions, credentials, and browser settings.

1. Session gets created with a `persistProfile` flag
2. Initial profile gets created with some information on the session and gets stored in an `UPLOADING` state
3. After the session is released, the userDataDir is persisted and the additional information on the profile is updated and the profile is set to the `READY` state
4. Whenever a session is created with the `profileId`, the profile is loaded from the storage and the session is started with the same userDataDir and context

#### Persist a profile when starting a session

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Start a session and persist the profile
const firstSession = await client.sessions.create({ persistProfile: true })
```

```python !! Python -wcn
# Start a session and persist the profile
first_session = client.sessions.create(persist_profile=True)
```
</CodeTabs>

#### Start a second session with your new profile

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Start a session with the persisted profile
const secondSession = await client.sessions.create({ profileId: firstSession.profileId })
```

```python !! Python -wcn
# Start a session with the persisted profile
second_session = client.sessions.create(profile_id=first_session.profile_id)
```
</CodeTabs>

This will return a profileId from the session which will allow you to pass it into new sessions in the future.

### Persisting browser information automatically

Persisting additional information about the browser session like auth, cookies, extensions, credentials, and browser settings is not on by default, to keep building up context with each session, pass persistProfile=True along with your profileId.

#### Update your profile after a new session

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Update the profile with new information, this will update the profile with whatever happens in the session
const thirdSession = await client.sessions.create({ profileId: firstSession.profileId, persistProfile: true })
```

```python !! Python -wcn
# Update the profile with new information, this will update the profile with whatever happens in the session
third_session = client.sessions.create(profile_id=first_session.profile_id, persist_profile=True)
```
</CodeTabs>

### Persisting browser information manually

You can also manually create and update a profile via the Profiles API. This allows you to update the proxy, user-agent, or replace the entire userDataDir for your profile.

#### Create your profile

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Create a new profile with new information
await client.profiles.create({ userDataDir: fs.readFileSync('path/to/userDataDir.zip'), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'})
```

```python !! Python -wcn
# Create a new profile with new information
with open("path/to/userDataDir.zip", "rb") as file:
    client.profiles.create(user_data_dir=file, user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3')
```
</CodeTabs>


#### Update your profile with some information

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Update the profile with new information, this will be used next session
await client.profiles.update(firstSession.profileId, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'})
```

```python !! Python -wcn
# Update the profile with new information, this will be used next session
client.profiles.update(first_session.profile_id, user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3')
```
</CodeTabs>


# Clustering
URL: /overview/self-hosting/clustering

---
title: Clustering
sidebarTitle: Clustering
description: Self-Hosting a Steel Browser Cluster
full: true
llm: true
---


# Docker
URL: /overview/self-hosting/docker

---
title: Docker
sidebarTitle: Docker
description: Self-Hosting Steel Browser Using Docker
full: true
llm: true
---
# Overview

This guide provides step-by-step instructions to set up your own Steel Browser instance using Docker. The setup consists of multiple deployment options – from the traditional docker-compose setup to the new, simplified single Docker image deployment.

## Prerequisites

* Docker (20.10.0 or later)
* At least 4GB of RAM
* 10GB of free disk space

## Quick Start Using Docker Compose

1. Create a new directory for your Steel Browser instance:

```bash Terminal -wc
mkdir steel-browser && cd steel-browser
```

2. Create the following file:

### docker-compose.yaml

```yaml YAML -wcn
services:
  api:
    image: ghcr.io/steel-dev/steel-browser-api:latest
    ports:
      - "3000:3000"
      - "9223:9223"
    volumes:
      - ./.cache:/app/.cache
    networks:
      - steel-network

  ui:
    image: ghcr.io/steel-dev/steel-browser-ui:latest
    ports:
      - "5173:80"
    depends_on:
      - api
    networks:
      - steel-network

networks:
  steel-network:
    name: steel-network
    driver: bridge
```

3. Launch the containers:

```bash Terminal -wc
docker compose up -d
```

4. Access Steel Browser by opening `http://localhost:5173` in your web browser.

## Alternative Deployment: Single Docker Image

Steel Browser can now be deployed using a single Docker image—no more complex docker-compose setup!

### Single Docker Image Deployment

Run the following command to launch Steel Browser:

```bash Terminal -wc
docker run --rm -it -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser:latest
```

This command will:
- Pull the latest Docker image from GitHub Container Registry.
- Expose the API on port 3000 and Chrome debugging on port 9223.
- Run the container interactively and remove it when stopped.

Access Steel Browser via your browser at `http://localhost:3000` and the UI at `http://localhost:3000/ui`.

## Building the Singular Docker Image Locally

If you wish to build the Docker image from source rather than relying on the pre-built image, follow these steps:

1. Clone the repository:

```bash Terminal -wc
git clone https://github.com/steel-dev/steel-browser.git
cd steel-browser
```

2. Build the Docker image:

```bash Terminal -wc
docker build -t steel-browser:local .
```

3. Run the newly built image:

```bash Terminal -wc
docker run --rm -it -p 3000:3000 -p 9223:9223 steel-browser:local
```

This method gives you the flexibility to modify the image locally. Compared to the docker-compose setup where the API and UI are managed in separate containers, here everything runs within one container, simplifying deployment for testing and development.

## Advanced Setup

### Building From Source with Docker Compose

If you prefer to build the containers yourself with docker-compose:

1. Clone the repository:

```bash Terminal -wc
git clone https://github.com/steel-dev/steel-browser.git
cd steel-browser
```

2. Create a `.env` file (optional).

3. Build and start using the development compose file:

```bash Terminal -wc
docker compose -f docker-compose.dev.yml up -d --build
```

_The “-d” flag runs the containers in the background._

### Configuration Options

* **API Port**: Default is 3000 (internally also 3000). If changed in the compose file, update the API binding accordingly.
* **UI Port**: Default is 5173 (or 80 inside container). Adjust if needed.
* **Chrome Debugging Port**: Default is 9223. Required for browser communication.

### Volume Persistence

The `.cache` directory stores Chrome data and extensions. Mount it as a volume for persistence:

```yaml YAML -wcn
volumes:
  - ./.cache:/app/.cache
```

## Architecture

Steel Browser consists of two main components when using docker-compose:

1. **API Container**: Runs Chrome in headless mode and provides CDP (Chrome DevTools Protocol) services.
2. **UI Container**: An Nginx-based frontend for interacting with the browser.

When using the single Docker image deployment, both the API and UI are integrated into one container.

## Customizing the Build

### Using a Different Chrome Version

The API container uses Chrome 128.0.6613.119 by default. To use a different version:

1. Create a custom Dockerfile based on the API one.
2. Modify the Chrome installation section:

```dockerfile Dockerfile -wcn
ARG CHROME_VERSION="128.0.6613.119"
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    curl \
    unzip \
    && CHROME_DEB="google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
    && wget -q "https://mirror.cs.uchicago.edu/google-chrome/pool/main/g/google-chrome-stable/${CHROME_DEB}"
    # ...rest of the installation...
```

### Changing Node Version

Both containers use Node 22.13.0 by default. To use a different version, modify the build arguments:

```yaml YAML -wcn
services:
  api:
    build:
      context: .
      dockerfile: ./api/Dockerfile
      args:
        NODE_VERSION: 18.19.0
```

## Troubleshooting

### Chrome Won't Start

Ensure your host has enough resources and check the API container logs:

```bash Terminal -wcn
docker logs steel-browser_api_1
```

Common issues include:
* Running on ARM architecture (There are official images for ARM, or build the image yourself)
* Insufficient memory
* Missing shared libraries
* Permission issues with the `.cache` directory

### Connectivity Issues

If the UI can't connect to the API:
1. Verify both containers are running.
2. Check if the API is accessible:

```bash Terminal -wcn
curl http://localhost:3000/api/health
```

3. Ensure the containers can communicate over the network:

```bash Terminal -wcn
docker exec steel-browser_ui_1 curl http://api:3000/api/health
```

## Production Deployment

For production environments:
1. Use specific image versions rather than `latest`.
2. Set up a proper reverse proxy with HTTPS.
3. Configure appropriate resource limits.

Example production compose file:

```yaml YAML -wcn
services:
  api:
    image: ghcr.io/steel-dev/steel-browser-api:sha256:...
    restart: always
    ports:
      - "3000:3000"
    deploy:
      resources:
        limits:
          memory: 2G
    volumes:
      - ./data/.cache:/app/.cache
    networks:
      - steel-network

  ui:
    image: ghcr.io/steel-dev/steel-browser-ui:sha256:...
    restart: always
    ports:
      - "5173:80"
    networks:
      - steel-network

networks:
  steel-network:
    name: steel-network
    driver: bridge
```

## Security Considerations

* Avoid exposing the Chrome debugging port (9223) to the public internet.
* Consider not exposing the API if the UI and API are running within the same secured network.
* Set up proper authentication if deploying publicly.
* Keep containers updated with the latest versions.

## Updating

To update to the latest version:

```bash Terminal -wcn
docker compose pull
docker compose up -d
```

For custom builds:

```bash Terminal -wcn
git pull
docker compose -f docker-compose.dev.yml up -d --build
```

:::callout
type: help
### Need help running locally?
Reach out to us on the **#help** channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Extensions
URL: /overview/self-hosting/extensions

---
title: Extensions
sidebarTitle: Extensions
description: Self-Hosting Steel Browser Using Extensions
full: true
llm: true
---


# Profiles
URL: /overview/self-hosting/profiles

---
title: Profiles
sidebarTitle: Profiles
description: Self-Hosting Steel Browser Using Profiles
full: true
llm: true
---


# Railway
URL: /overview/self-hosting/railway

---
title: Railway
sidebarTitle: Railway
description: A quick guide on deploying Steel Browser to Railway using our template
full: true
llm: true
---
[Deploy the Template on Railway ↗](https://railway.com/deploy/steelbrowser?referralCode=Jwc4kg&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Overview
Hosting Steel Browser on Railway provides a reliable, scalable environment for running headless Chrome instances. The Steel Browser API handles browser session management, proxy configuration, and CDP passthroughs while Railway provides extremely easy APIs to scale and handles resource allocation automatically. Running Steel Browser on Railway's infrastructure ensures your browser automations run consistently with minimal configuration, while providing automatic scaling and health monitoring for production workloads.

### Common Use Cases
- **Web Scraping:** Extract data from dynamic websites that require JavaScript rendering
- **Browser Automation:** Automate repetitive web tasks and workflows
- **End-to-End Testing:** Run automated browser tests for web applications
- **Screenshot & PDF Generation:** Capture screenshots or generate PDFs from web content
- **Data Collection:** Gather information from multiple web sources programmatically

### Dependencies for Hosting Steel Browser
- **Docker:** Steel Browser runs as a containerized application
- **Chrome/Chromium:** Headless browser engine (included in the Docker image)
- **Node.js Runtime:** Required for the Steel Browser service

### Deployment Dependencies
- [Steel Browser GitHub Repository](https://github.com/steel-dev/steel-browser)
- [Steel Browser Documentation](https://docs.steel.dev/)
- [Chrome DevTools Protocol Documentation](https://chromedevtools.github.io/devtools-protocol/)

### Implementation Details

**Health Check Endpoint:**

Verify your instance is running:

```bash Terminal -wcn
curl https://your-domain.railway.app/v1/health
```

**Connecting to Steel Browser:**
After deployment, create a session and connect to your Steel Browser instance on the public domain using Playwright:

```typescript Typescript -wcn
import { chromium } from "playwright";
import Steel from "steel-sdk";
const client = new Steel({
  baseUrl: `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`,
});
session = await client.sessions.create();
browser = await chromium.connectOverCDP(session.websocketUrl);
// The rest of your automation
```


### Why Deploy Steel Browser on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Steel Browser on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

**Benefits of Steel Browser on Railway:**
- Automatic HTTPS/SSL configuration
- Built-in health monitoring
- Easy scaling as your browser automation needs grow
- Simple environment variable management
- Seamless integration with other Railway services

### Post-Deployment Notes

After deploying this template, users should:

1. **Access the Instance:** Navigate to the Railway-provided public domain
2. **Verify Health:** Check the `/v1/health` endpoint returns a successful response
3. **Configure API Access:** Use the public domain URL in their application code
4. **Monitor Usage:** Check Railway's metrics dashboard for resource usage

### Security Considerations:
- Consider adding authentication if exposing publicly
- Monitor for unusual traffic patterns
- Set up rate limiting if needed for production use


# Render
URL: /overview/self-hosting/render

---
title: Render
sidebar: false
isLink: true
llm: false
---


# Steel Local vs Steel Cloud
URL: /overview/self-hosting/steel-local-vs-steel-cloud

---
title: Steel Local vs Steel Cloud
sidebarTitle: Steel Local vs Steel Cloud
description: What's the difference between local Steel and Steel Cloud?
llm: true
---
# Overview

| Feature          | Steel Local                               | Steel Cloud                                                  |
|------------------|-------------------------------------------|--------------------------------------------------------------|
| Concurrency      | 1                                         | 100+                                                         |
| Stealth          | Limited                                   | Advanced Stealth (docs)                                      |
| Captcha Solving  | None                                      | Supported with the Captchas API                              |
| Proxies          | Bring your own                            | Bring your own + Steel Managed Proxies                       |
| Multi-Region     | Host it yourself                          | Supported with region flag during session creation           |
| Credentials      | Not supported                             | Supported with the Credentials API                           |
| Extensions       | Supported by loading in `api/extensions/` | Supported by using the Extensions API                        |
| Files            | Not supported                             | Supported by the Files API                                   |


The defining factor between running Steel locally and using Steel Cloud is concurrency.

For the Extensions API, if you put the extensions you would like to build/load in the `api/src/extensions/` folder then Steel Local will build these and inject them into the session. Credentials are not supported in Steel Local.

:::callout
type: help
### Need help running locally?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# WebRTC
URL: /overview/self-hosting/webrtc

---
title: WebRTC
sidebarTitle: WebRTC
description: Self-Hosting Steel Browser Using WebRTC
full: true
llm: true
---


# Implement Human-in-the-Loop Controls
URL: /overview/sessions-api/human-in-the-loop

---
title: Implement Human-in-the-Loop Controls
description: How to let users take control of Steel browser sessions
sidebarTitle: Implement Human-in-the-Loop Controls
llm: true
---

Steel's debug URL feature allows you to implement human-in-the-loop workflows where users can directly interact with and control browser sessions. This is particularly useful when you need users to take temporary control of automated browser sessions.

### Prerequisites

*   Basic familiarity with [Steel sessions](https://docs.steel.dev/overview/sessions-api/overview)

*   Understanding of [debug URLs](https://docs.steel.dev/overview/guides/view-and-embed-live-sessions)

*   A Steel API key




### Making Sessions Interactive

To enable human interaction with a session, you'll need to configure two key parameters when embedding the session viewer:

*   `interactive=true`: Enables users to interact with the page through clicks, scrolling, and form inputs

*   `showControls=true`: Shows the navigation bar where users can enter URLs and use forward/back controls
```typescript Typescript -wcn
<iframe
  src={`${session.debugUrl}?interactive=true&showControls=true`}
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

When both parameters are enabled, users can:

*   Click and interact with elements on the page

*   Scroll the page

*   Enter new URLs in the navigation bar

*   Use browser-style forward/back navigation

*   Fill out forms and input fields

*   Navigate through websites naturally




If you’re building user facing agents, this is particularly useful when you need users to:

*   Take control of an automated session that needs assistance

*   Enter sensitive information like login credentials

*   Solve CAPTCHAs

*   Verify or correct automated actions

*   Demonstrate actions that will be automated




### Implementation Examples

#### React Implementation

Here's how to embed an interactive session viewer into a React Application:
```typescript Typescript -wcn
// SessionViewer.tsx
import React from 'react';

type SessionViewerProps = {
    debugURL: string;
};

const SessionViewer: React.FC<SessionViewerProps> = ({ debugURL }) => {
    return (
        <div className="session-container">
            <div
                className="status-banner"
                style={{
                    background: '#f0f0f0',
                    padding: '10px',
                    marginBottom: '10px',
                    textAlign: 'center',
                }}
            >
                Automated session - Click inside to take control
            </div>

            <iframe
                src={`${debugURL}?interactive=true&showControls=true`}
                style={{
                    width: '100%',
                    height: '600px',
                    border: 'none',
                }}
                title="Browser Session"
            />
        </div>
    );
};

export default SessionViewer;

// Usage in App.tsx
import React from 'react';
import SessionViewer from './SessionViewer';

const App: React.FC = () => {
    return (
        <div className="App">
            <h1>Browser Automation Dashboard</h1>
            <SessionViewer debugURL="YOUR_debug_URL" />
        </div>
    );
};

export default App;
```

### Best Practices

*   Ensure your iframe container is large enough for comfortable interaction (recommended minimum height: 600px)

*   Make it clear to users when they can interact with the session

*   Remember that any actions taken in an interactive session affect the actual browser session & state




### What's Next

Learn about session timeouts for managing interactive sessions:

Session Lifecycle

Learn how to start and release browser sessions programatically.


# Mobile Mode
URL: /overview/sessions-api/mobile-mode

---
title: Mobile Mode
sidebarTitle: Mobile Mode
description: Create browser sessions that appear as mobile devices with full mobile fingerprints and touch capabilities.
llm: true
---

### Overview

Mobile mode allows Steel sessions to appear as mobile devices. Pass `deviceConfig: { device: "mobile" }` when creating a session and the browser presents itself with mobile user agent, viewport, touch capabilities, and browser characteristics—everything aligned to look like a phone instead of desktop.

Most websites serve fundamentally different experiences to mobile devices. Desktop sites have nested navigation, hover menus, and complex interactions. Mobile sites strip these away into linear flows and touch-optimized interfaces. For AI agents, this simplification can directly improve task completion.

### How It Works

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';
import { chromium } from 'playwright';

const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

// Create a session with mobile device configuration
const session = await client.sessions.create({
  deviceConfig: { device: "mobile" }
});

// Connect to the mobile session
const browser = await chromium.connectOverCDP(
  `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
);

const page = await browser.contexts()[0].pages()[0];
await page.goto('https://example.com');
```

```python !! Python -wcn
from steel import Steel
from playwright.async_api import async_playwright
import os

client = Steel(steel_api_key=os.environ.get("STEEL_API_KEY"))

# Create a session with mobile device configuration
session = client.sessions.create(
    device_config={"device": "mobile"}
)

# Connect to the mobile session
async with async_playwright() as p:
    browser = await p.chromium.connect_over_cdp(
        f"wss://connect.steel.dev?apiKey={os.environ.get('STEEL_API_KEY')}&sessionId={session.id}"
    )
    
    page = browser.contexts[0].pages[0]
    await page.goto('https://example.com')
```

</CodeTabs>

The session automatically configures mobile viewport dimensions, touch events, and a full mobile device fingerprint. Sites see a consistent mobile device visiting from a browser app, not a desktop browser with a spoofed user agent. Before this, you could override the user agent string, but the rest of the fingerprint wouldn't match—sites would detect the inconsistency.

Mobile mode works with all existing features including proxies, CAPTCHA solving, and session persistence.

### Why This Matters

**Simplified Navigation**

Mobile sites present content sequentially rather than using nested menus or hover states. An e-commerce checkout that requires navigating dropdown menus on desktop becomes a vertical list on mobile. Fewer interactive elements means clearer action spaces and less chance of mistakes.

**Performance and Cost Benefits**

Mobile sites load faster with fewer widgets and less aggressive lazy-loading. They also have simpler DOM structures. Less HTML for your model to process means lower token costs. If you're using vision, it means fewer image tokens too.

**Consistent Fingerprints**

Without mobile mode, your sessions use desktop fingerprints by default. Mobile mode provides a complete, consistent mobile device fingerprint that websites trust.

:::callout
type: help
### Need help with mobile mode?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) or [@steeldotdev](https://twitter.com/steeldotdev).

Part of Steel's launch week. More at [steel.dev/launch-week](https://steel.dev/launch-week).
:::


# Multi-region
URL: /overview/sessions-api/multi-region

---
title: Multi-region
sidebarTitle: Multi-region
description: Control where your Steel browser sessions are hosted for optimal performance and latency.
llm: true
---
### Overview

By default, Steel automatically selects the data center closest to the client’s request location when creating a new browser session. This ensures optimal performance and minimal latency for your browser automation tasks. However, you can also manually specify which region you want your browser session to run in using the `region` parameter.

This region selection determines the physical location of the browser instance itself, which can help reduce latency for applications targeting specific geographic areas or comply with data residency requirements.

### Automatic Region Selection

When you create a session without specifying a region, Steel automatically determines the closest data center based on your request location:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

// Automatically uses the closest region
const session = await client.sessions.create();
```

```python !! Python -wcn
from steel import Steel

client = Steel()

# Automatically uses the closest region
session = client.sessions.create()
```
</CodeTabs>

### Manual Region Selection

To specify a particular region for your browser session, use the `region` parameter when creating a session:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

// Create session in Los Angeles data center
const session = await client.sessions.create({
    region: "lax"
});
```

```python !! Python -wcn
from steel import Steel

client = Steel()

# Create session in Los Angeles data center
session = client.sessions.create(
    region="lax"
)
```
</CodeTabs>


### Available Regions

Steel is available in the following regions:

| Region         | Code | Data Center Location      |
|----------------|------|---------------------------|
| Los Angeles    | LAX  | Los Angeles, USA          |
| Washington DC  | IAD  | Washington DC, USA        |

### Region vs Proxy Selection

Region selection determines where your browser session runs, which is different from proxy selection. The region parameter controls the physical location of the browser instance, while the useProxy and proxyUrl parameters control the network routing and IP address used by the browser for web requests.

You can combine region selection with proxy settings:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Browser runs in Frankfurt, but uses a US proxy for requests
const session = await client.sessions.create({
    region: "lax",
    useProxy: true
});

```

```python !! Python -wcn
# Browser runs in Frankfurt, but uses a US proxy for requests
session = client.sessions.create(
    region="lax",
    use_proxy=True
)
```
</CodeTabs>

We'll be launching new features soon to allow you to control regions for proxies as well. Right now, all are US based.

:::callout
type: help
### Need help building with multi-region?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Overview
URL: /overview/sessions-api/overview

---
title: Overview
sidebarTitle: Overview
description: The Sessions API lets you create and control cloud-based browser sessions through simple API calls. Each session is like a fresh incognito window, but running in our cloud and controlled through code.
llm: true
---

[Go to Quickstart Example](/overview/sessions-api/quickstart)

### What is a Session?

Sessions are the atomic unit of our Sessions API. Think of sessions as giving your AI agents their own dedicated browser windows. Just like you might open an incognito window to start a fresh browsing session, the Sessions API lets your agents spin up isolated browser instances on demand. Each session maintains its own state, cookies, and storage - perfect for AI agents that need to navigate the web, interact with sites, and maintain context across multiple steps.

### Get started

[Getting Started](/overview/sessions-api/quickstart)

### Connect with your preferred tools

[Connect with Puppeteer](/cookbook/puppeteer)

[Connect with Playwright](/cookbook/playwright)

[Connect with Playwright (Python)](/cookbook/playwright-python)

[Connect with Selenium](/cookbook/selenium)

[Python SDK Reference](/steel-python-sdk)

[Node SDK Reference](/steel-js-sdk)

### Understanding sessions

[Session Lifecycle](/overview/sessions-api/session-lifecycle)

:::callout
type: help
### Need help building with the Sessions API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev/) under the community ⭐ section.
:::


# Quickstart
URL: /overview/sessions-api/quickstart

---
title: Quickstart
sidebarTitle: Quickstart
description: Get up a running with your first Steel Session in a few minutes.
---

### Overview

This guide will walk you through setting up your Steel account, creating your first browser session in the cloud, and driving it using Typescript/Playwright. In just a few minutes, you'll be up and programatically controlling a Steel browser Session.

### Initial Setup

#### 1\. Create a Steel Account

1.  Sign up for a free account at steel.dev

2.  The free plan includes 100 browser hours to get you started

3.  No credit card required


#### 2\. Get Your API Key

1.  After signing up, navigate to Settings > API Keys

2.  Create an API key and save it somewhere safe. You will not be able to generate the same key again.


#### 3\. Set Up Environment Variables

1.  Create a `.env` file in your project root (if you don't have one)

2.  Add your Steel API key:


Make sure to add `.env` to your `.gitignore` file to keep your key secure

### Installing Dependencies

Install the Steel SDK and Playwright:

```package-install
steel-sdk playwright
```


### Create Your First Session

Let's create a simple script that launches and then releases a Steel session:

```typescript Typescript -wcn -f steel-client.ts
import Steel from 'steel-sdk';
import dotenv from 'dotenv';

dotenv.config();

const client = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

async function main() {
  // Create a session
  const session = await client.sessions.create();
  console.log('Session created:', session.id);
  console.log(`View live session at: ${session.sessionViewerUrl}`);

  // Your session is now ready to use!
  // When done, release the session
  await client.sessions.release(session.id);
  console.log('Session released');
}

main().catch(console.error);
```

### Connecting to Your Session

Now that you have a session, you can connect to it using your preferred automation tool.


```typescript Typescript -wcn -f puppeteer.ts
import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`,
});

const page = await browser.newPage();
await page.goto('https://example.com');
```


### Session Features

Want to do more with your session? Here are some common options you can add when creating:

```typescript Typescript -wcn
const session = await client.sessions.create({
    useProxy: true,           // Use Steel's residential proxy network
    solveCaptcha: true,       // Enable automatic CAPTCHA solving
    timeout: 1800000,      // Set 30-minute timeout (default is 5 minutes)
    userAgent: 'custom-ua'    // Set a custom user agent
});
```

You've now created your first Steel session and learned the basics of session management. With these fundamentals, you can start building more complex automations using Steel's cloud browser infrastructure.

:::callout
type: help
### Need help building with the Sessions API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Reusing Context & Auth
URL: /overview/sessions-api/reusing-auth-context

---
title: Reusing Context & Auth
description: How to Reuse Authentication Across Steel Sessions
sidebarTitle: Reusing Context & Auth
llm: true
---

The Steel Sessions API provides a `contexts` endpoint that allows you to capture and transfer browser state (including cookies and local storage) between sessions. This is particularly useful for maintaining authenticated states across multiple sessions, helping your AI agents access protected resources efficiently without repeatedly handling login processes or exposing credentials at all.

In this guide, you'll learn how to use the Steel Sessions API to reuse authentication between browser sessions.

:::callout
For an easier way to reuse authentication, context, cookies, extensions etc. consider using Steel's new [Profiles API](/overview/profiles-api/overview). It utilizes auth context alongside a complete browser profile to automatically reuse all your auth, not just context or cookies.
:::

For additional practical examples and recipes, check out the [Steel Cookbook](https://github.com/steel-dev/steel-cookbook).



### Prerequisites

*   Steel API Key

*   [Steel SDK](https://github.com/steel-dev/steel-python) installed.
```package-install
steel-sdk
```

*   Familiarity with [Steel sessions](https://docs.steel.dev/overview/sessions-api/overview)




### Overview of the Process

Reusing authentication across sessions involves a straightforward workflow:

*   **Create and authenticate an initial session.**
    Create a Steel session, navigate to target websites, and authenticate (log-in, etc).

*   **Capture the session context.**
    Extract browser state data through the `GET /v1/sessions/{id}/context` endpoint. This endpoint returns a context object containing browser state information such as cookies and local storage.
    **Example:**

    ```typescript Typescript -wcn
    const initialSessionContext = await client.sessions.context(initialSession.id);
    ```

*   **Reuse session context in new sessions.**
    Create new sessions using the captured context object by passing it directly to the `sessionContext` parameter.
    **Example:**

    ```typescript Typescript -wcn
    const session = await client.sessions.create({ sessionContext: initialSessionContext });
    ```

    Now your new session will begin with the same authenticated state as your previous session without having to manually authenticate again.




### Complete Example (Playwright, Node.js)

**Note**: While this example uses TypeScript, Node.js, and Playwright, the same logic applies regardless of your programming language or automation framework. The Steel API handles the context management - you just need to capture and reuse it using your preferred tools.

The following script demonstrates the entire authentication reuse process. It:

*   Creates an initial session and authenticates with a webesite by logging in

*   Captures the authenticated session context

*   Creates a new session using the captured context

*   Verifies the authentication was successfully transferred to the new session


```typescript Typescript -wcn
import { chromium, Page } from "playwright";
import Steel from "steel-sdk";
import dotenv from "dotenv";

dotenv.config();

const client = new Steel({
  steelAPIKey: process.env.STEEL_API_KEY,
});

// Helper function to perform login
async function login(page: Page) {
  await page.goto("https://practice.expandtesting.com/login");
  await page.fill('input[name="username"]', "practice");
  await page.fill('input[name="password"]', "SuperSecretPassword!");
  await page.click('button[type="submit"]');
}

// Helper function to verify authentication
async function verifyAuth(page: Page): Promise<boolean> {
  await page.goto("https://practice.expandtesting.com/secure");
  const welcomeText = await page.textContent("#username");
  return welcomeText?.includes("Hi, practice!") ?? false;
}

async function main() {
  let session;
  let browser;

  try {
    // Step 1: Create and authenticate initial session
    console.log("Creating initial Steel session...");
    session = await client.sessions.create();
    console.log(
      `\x1b[1;93mSteel Session #1 created!\x1b[0m\n` +
        `View session at \x1b[1;37m${session.sessionViewerUrl}\x1b[0m`
    );

    // Connect Playwright to the session
    browser = await chromium.connectOverCDP(
      `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
    );

    const page = await browser.contexts()[0].pages()[0];
    await login(page);

    if (await verifyAuth(page)) {
      console.log("✓ Authentication successful");
    }

    // Step 2: Capture and transfer authentication
    const sessionContext = await client.sessions.context(session.id);

    // Clean up first session
    await browser.close();
    await client.sessions.release(session.id);
    console.log("Session #1 released");

    // Step 3: Create new authenticated session

    session = await client.sessions.create({ sessionContext });
    console.log(
      `\x1b[1;93mSteel Session #2 created!\x1b[0m\n` +
        `View session at \x1b[1;37m${session.sessionViewerUrl}\x1b[0m`
    );

    // Connect to new session
    browser = await chromium.connectOverCDP(
      `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
    );

    // Verify authentication transfer
    const newPage = await browser.contexts()[0].pages()[0];
    if (await verifyAuth(newPage)) {
      console.log("\x1b[32m✓ Authentication successfully transferred!\x1b[0m");
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    // Cleanup
    await browser?.close();
    if (session) {
      await client.sessions.release(session.id);
      console.log("Session #2 released");
    }
  }
}

main().catch(console.error);
```

Check out the full example

### Important Considerations

*   **Cookie and JWT Based Authentication Only:**
    This method works exclusively with websites that utilize cookie-based or JWT-based authentication (saved onto Local Storage).

*   **Enhancing Continuity:**
    A useful practice is to save the URL of the last visited page along with the session context. This allows you to restore the browsing context, providing continuity for users.

*   **Session Security:**
    Treat captured contexts as sensitive data. Ensure proper security and regularly refresh your sessions to maintain account integrity.

*   **Available for Live Sessions:**
    Context can only be captures from live sessions. So if you wish to re-use a context, make sure to grab the object _before_ releasing the session.


# Session Lifecycle
URL: /overview/sessions-api/session-lifecycle

---
title: Session Lifecycle
sidebarTitle: Session Lifecycle
description: Learn how to start and release browser sessions programatically.
llm: true
---

### Overview
Sessions are the foundation of browser automation in Steel. Each session represents an isolated browser instance that persists until it's either explicitly released or times out.

Each session can be in one of three states:

*   **Live**: The session is active and ready to accept commands/connections. This is the state right after creation and during normal operation.

*   **Released**: The session has been intentionally shut down, either through explicit release or timeout. Resources have been cleaned up. Can no longer accept commands/connections.

*   **Failed**: Something went wrong during the session's lifetime (like a crash or connection loss). These sessions are automatically cleaned up.


Browser sessions are billed and metered by the minute. A session can last up to 24 hours depending on your plan.

Understanding how sessions live and die helps you manage resources effectively and build more reliable applications.

### Session Lifetime and Timeout

When you start a session, it stays alive for 5 minutes by default but you can change it by passing the timeout parameter. After the time passes, the session will be automatically released.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

// Create session and keep it running for 10 minutes.
const session = await client.sessions.create({
  timeout: 600000 // 10 minutes (NOTE: Units are in milliseconds)
});
```


```python !! Python -wcn
import os
from steel import Steel

client = Steel()

# Create session and keep it running for 10 minutes.
session = client.sessions.create(
    api_timeout=600000 # 10 minutes (NOTE: Units are in milliseconds)
)
```
</CodeTabs>

**Note:** Currently, Steel doesn’t support editing a the timeout duration of a live session.

### **Releasing a Session**

When you're done with a session, it's best practice to release it explicitly rather than waiting for the timeout. You can release a session any time before the timeout is up by calling the `release` method.


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Release a single session
const response = await client.sessions.release(session.id);
```


```python !! Python -wcn
# Release a single session
response = client.sessions.release(session.id)
```
</CodeTabs>

#### Bulk Session Release

Sometimes you need to clean up all active sessions at once. Steel provides a convenient way to do this:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Release all active sessions
const response = await client.sessions.releaseAll();
console.log(response.message); // "All sessions released successfully"
```


```python !! Python -wcn
# Release all active sessions
response = client.sessions.release_all()
print(response.message) # "All sessions released successfully"
```

</CodeTabs>

:::callout
type: help
### Need help building with the Sessions API?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Captcha Solving
URL: /overview/stealth/captcha-solving

---
title: Captcha Solving
sidebarTitle: Captcha Solving
description: CAPTCHA solving is one of Steel's advanced capabilities that helps AI agents and automation tools navigate the modern web more effectively. This document explains how our CAPTCHA solving system works, what types of CAPTCHAs we support, and best practices for implementation.
fullL: true
llm: true
---

### How Steel Handles CAPTCHAs

Steel takes a two-pronged approach to dealing with CAPTCHAs:

1.  **Prevention First**: Our sophisticated browser fingerprinting and anti-detection systems often prevent CAPTCHAs from appearing in the first place. We maintain realistic browser profiles that make your automated sessions appear more human-like, reducing the likelihood of triggering CAPTCHA challenges.

2.  **Automatic Solving**: When CAPTCHAs do appear, our automatic solving system kicks in to handle them transparently, allowing your automation to continue without interruption.


### Supported CAPTCHA Types

Currently, Steel's auto-solver supports these CAPTCHA services:

✅ **Currently Supported**:

*   ReCAPTCHA v2 / v3

*   Cloudflare Turnstile

*   ImageToText CAPTCHAs

*   Amazon AWS WAF


🔜 **Coming Soon**:

*   GeeTest v3/v4


❌ **Not Currently Supported**:

*   Custom implementation CAPTCHAs

*   Enterprise-specific CAPTCHA systems

*   FunCAPTCHA

*   Other specialized CAPTCHA types


### How CAPTCHA Solving Works

When you enable CAPTCHA solving in your Steel session, here's what happens behind the scenes:

1.  **Detection**: Our system continuously monitors the page for CAPTCHA elements using multiple detection methods:

    *   DOM structure analysis

    *   Known CAPTCHA iframe patterns

    *   Common CAPTCHA API endpoints

    *   Visual element detection

2.  **State Management**: CAPTCHA states are tracked per page with real-time updates

3.  **Classification**: Once detected, the system identifies the specific type of CAPTCHA and routes it to the appropriate solver.

4.  **Solving**: CAPTCHAs are then solved by us using various methods:

    *   Machine learning models

    *   Third-party solving services

    *   Browser automation techniques

    *   Token manipulation (when applicable)

5.  **Verification**: The system verifies that the CAPTCHA was successfully solved before allowing the session to continue.


### Session Configuration

To enable autosolving, simply set `solveCaptcha: true` when creating a session.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import Steel from 'steel-sdk';

const client = new Steel();

const session = await client.sessions.create({
  solveCaptcha: true
});
```

```python !! Python -wcn
from steel import Steel

client = Steel()
session = client.sessions.create(
    solve_captcha=True
)
```
</CodeTabs>

To detect CAPTCHAs without automatically solving them, disable `autoCaptchaSolving` in the stealth config:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const session = await client.sessions.create({
  solveCaptcha: true,
  stealthConfig: {
    autoCaptchaSolving: false
  }
});
```

```python !! Python -wcn
session = client.sessions.create(
    solve_captcha=True,
    stealth_config={
        "autoCaptchaSolving": False
    }
)
```
</CodeTabs>

### Manual Solving

If auto-solving is disabled, use the solve endpoint to trigger solving. You can solve all detected CAPTCHAs or target specific ones.

The `taskId`, `url`, and `pageId` required for targeting specific CAPTCHAs can be retrieved from the [CAPTCHA status response](/overview/captchas-api/overview#getting-captcha-status). When using `taskId`, use the value from the task's `id` field.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Solve all detected CAPTCHAs
await client.sessions.captchas.solve('sessionId');

// Solve specific task
await client.sessions.captchas.solve('sessionId', { taskId: 'task_123' });

// Solve by URL
await client.sessions.captchas.solve('sessionId', { url: 'https://example.com' });

// Solve by Page ID
await client.sessions.captchas.solve('sessionId', { pageId: 'page_123' });
```

```python !! Python -wcn
# Solve all detected CAPTCHAs
client.sessions.captchas.solve("sessionId")

# Solve specific task
client.sessions.captchas.solve("sessionId", task_id="task_123")

# Solve by URL
client.sessions.captchas.solve("sessionId", url="https://example.com")

# Solve by Page ID
client.sessions.captchas.solve("sessionId", page_id="page_123")
```
</CodeTabs>

### Best Practices for Implementation

#### 1\. Implement Proper Waiting

When navigating to pages that might contain CAPTCHAs, it's important to implement proper waiting strategies:

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Typescript example using Puppeteer
await page.waitForNetworkIdle();  // Wait for network activity to settle
await page.waitForTimeout(2000);  // Additional safety buffer
```

```python !! Python -wcn
# Python example using Playwright
await page.wait_for_load_state('networkidle')  # Wait for network activity to settle
await page.wait_for_timeout(2000)  # Additional safety buffer
```
</CodeTabs>

#### 2. Detecting CAPTCHA Presence

You can detect CAPTCHA presence using these selectors:

```typescript Typescript -wcn
// Common CAPTCHA selectors
const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    '#captcha-box',
    '[class*="captcha"]'
];
```


### Important Considerations

1.  **Plan Availability**: CAPTCHA solving is only available on Developer, Startup, and Enterprise plans. It is not included in the free tier.

2.  **Success Rates**: While our system has high success rates, CAPTCHA solving is not guaranteed to work 100% of the time. Always implement proper error handling.

3.  **Timing**: CAPTCHA solving can add latency to your automation. Account for this in your timeouts and waiting strategies.

4.  **Rate Limits**: Even with successful CAPTCHA solving, respect the target site's rate limits and terms of service.


### Common Issues and Solutions

1.  **Timeout Issues**

    *   Increase your session timeout when working with CAPTCHA-heavy sites

    *   Implement exponential backoff for retries

2.  **Detection Issues**

    *   Use Steel's built-in stealth profiles

    *   Implement natural delays between actions

    *   Rotate IP addresses using Steel's proxy features

3.  **Solving Failures**

    *   Implement proper error handling

    *   Have fallback strategies ready

    *   Consider implementing manual solving as a last resort


### Best Practices for Avoiding CAPTCHAs

1.  **Use Steel's Fingerprinting**: Our automatic fingerprinting often helps bypass avoidable CAPTCHAs entirely by making your sessions appear more human-like.

2.  **Session Management**:

    *   Reuse successful sessions when possible

    *   Maintain cookies and session data

    *   Use Steel's session persistence features

3.  **Request Patterns**:

    *   Implement natural delays between actions

    *   Vary your request patterns

    *   Avoid rapid, repetitive actions


### Looking Forward

Steel is continuously improving its CAPTCHA handling capabilities. We regularly update our solving mechanisms to handle new CAPTCHA variants and improve success rates for existing ones.

Stay updated with our documentation for the latest information about supported CAPTCHA types and best practices.

:::callout
type: help
### Need help building with captcha solving?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Proxies
URL: /overview/stealth/proxies

---
title: Proxies
sidebarTitle: Proxies
description: Proxies make your browser sessions appear to originate from different locations and IP addresses. This is essential for accessing geo-restricted content, avoiding rate limits, and maintaining anonymity during web automation.
llm: true
---

## Overview
Steel offers two powerful ways to use proxies: our built-in **Managed Residential Proxies** or connecting to your own proxy provider with our **Bring Your Own Proxy (BYOP)** feature.

### Which Proxy Approach Should you choose?

Use this table to pick the right option for your project.

| Feature     | Steel-Managed Proxies                                                                 | Default Behavior (No proxies)                                 | Bring Your Own Proxies (BYOP)                                         |
|-------------|---------------------------------------------------------------------------------------|---------------------------------------------------------------|------------------------------------------------------------------------|
| Best For    | Quickly accessing high-quality residential IPs from specific countries without setup. | General web access, testing, or sites that don't block datacenter IPs. | Full control over your proxy infrastructure, using specialized providers. |
| IP Type     | High-quality residential IPs                                                          | Datacenter                                                    | Any (Datacenter, Residential, Mobile)                                |
| Control     | Managed by Steel (automatic rotation)                                                 | Static datacenter IP assigned by Steel                        | Full control over IPs and rotation logic                             |
| Cost        | Billed per GB of usage by Steel                                                       | Free (included in all plans)                                  | No charge from Steel; you pay your own proxy provider                |
| Availability| Developer, Pro, & Enterprise plans                                                    | All plans, including Hobby (free)                             | All plans, including Hobby (free)                                    |


### Steel-Managed Proxies

⭐ **_This is the best option for most use-cases._**

Steel maintains a high-quality pool of residential IP addresses that make your browser sessions appear to come from real user connections. Our residential proxy network includes:

*   **Hundreds of millions of IP addresses** sourced from legitimate residential connections

*   **United States locations by default** with options for global geographic targeting

*   **Continuous quality monitoring** through our internal testing and validation systems

*   **Automatic IP rotation** to ensure fresh addresses for each session


These proxies are ideal for accessing sites that block datacenter IPs or when you need to appear as a genuine residential user.

### Default Behavior (No Proxies)

When you create a Steel session without enabling proxies, your requests originate from the datacenter/machine’s IP addresses where Steel's browser infrastructure is hosted. This option is free, available on all plans, and incurs no charges on proxy bandwidth. This approach works well for:

*   Interacting with websites that aren’t blocking default these datacenter IPs

*   General web scraping that doesn't require specific geographic locations

*   Internal applications or APIs that don't have geo-restrictions

*   Testing and development where IP location isn't critical


### Bring Your Own Proxies (BYOP)

If you have existing proxy infrastructure or specific proxy requirements, you can route Steel sessions through your own proxy servers. This approach gives you:

*   **Complete control** over your proxy infrastructure and IP sources

*   **No additional costs** from Steel - you only pay for your own proxy services

*   **Flexibility** to use specialized proxy providers or custom configurations

*   **Compatibility** with both Steel Cloud and the open-source Steel browser


By default, proxies are disabled (`useProxy: false` is the implicit setting). This means your traffic originates from Steel's own datacenter IPs.

### Using Steel-Managed Residential Proxies

To enable it, simply set `useProxy: true` when creating a session. By default, your traffic will be routed through a new US-based IP address each session:


<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Typescript SDK
const session = await client.sessions.create({
    useProxy: true
});
```

```python !! Python -wcn
# Python SDK
session = client.sessions.create(
    use_proxy=True
)
```
</CodeTabs>

### Geographic Targeting

You can easily target countries, states (US only), or cities:

**Quality vs. Specificity**

The more specific your targeting, the smaller the IP pool. For the best performance and highest quality IPs, use the broadest targeting that meets your needs (e.g., prefer country-level over city-level). Generally, we’ve seen US and GB proxies have the highest quality.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Target specific state
const session = await client.sessions.create({
  useProxy: {
    geolocation: { country: "US", state: "NY" },
  },
});

// Target specific city
const session = await client.sessions.create({
  useProxy: {
    geolocation: { city: "LOS_ANGELES" },
  },
});
```


```python !! Python -wcn
# Target specific state
session = client.sessions.create(
    use_proxy={
        "geolocation": { "country": "US", "state": "NY" }
    }
)

# Target specific city
session = client.sessions.create(
    use_proxy={
        "geolocation": { "city": "LOS_ANGELES" }
    }
)
```

</CodeTabs>

**Available targeting options:**

*   **Countries**: We support over 200 countries via their two-letter Alpha-2 codes

*   **States**: Supported for the US only

*   **Cities**: Available for major global cities


### Bring Your Own Proxies (BYOP)

If you already have a proxy provider or need highly specialized configurations, you can route Steel sessions through your own proxy server. This gives you complete control and avoids any additional proxy fees from Steel.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
// Typescript SDK
const session = await client.sessions.create({
  useProxy: {
    server: "http://username:password@proxy.example.com:8080",
  },
});
```

```python !! Python -wcn
# Python SDK
session = client.sessions.create(
    use_proxy={
        "server": "http://username:password@proxy.example.com:8080"
    }
)
```
</CodeTabs>

**Supported proxy formats:**

*   `http://username:password@hostname:port`

*   `https://username:password@hostname:port`

*   `socks5://username:password@hostname:port`


Your proxy credentials are handled securely and never logged or stored by Steel beyond the duration of your session.

#### Proxy Connection Errors

You may occasionally encounter proxy connection errors like `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_CONNECTION_FAILED`, or `ERR_CONN_REFUSED`. This error indicates a connectivity issue between Steel's infrastructure and the proxy server.

**This is normal behavior** and can happen for several reasons:

*   Temporary proxy server unavailability

*   Network connectivity issues between Steel and the proxy

*   The target website blocking the specific proxy IP


**When this happens:**

1.  **Retry your request.** These errors are usually transient.

2.  If using **Steel-Managed proxies,** we automatically rotate to a new IP on retry.

3.  If using **BYOP**, ensure your proxy server is online and accessible.


If the error persists across multiple retries, it may point to a more systemic issue.

#### **Website Blocking**

To maintain a high-quality and compliant network, Steel and its partners may restrict access to certain websites. We do this to ensure the long-term health and reputation of our IP pool. Blocklists are typically maintained for:

*   Gambling and betting websites

*   Government and restricted institutional sites

*   Ticketing websites

*   Other categories flagged for compliance reasons


**If you're experiencing unexpected or persistent blocking:**

1.  **Change the geographic region.** A different IP block might solve the problem.

2.  **Use BYOP.** If you need access to specific restricted content, using your own proxy provider gives you full control.

3.  **Contact Support.** If you believe a legitimate site is being blocked, please let us know. If retries and changing regions consistently fail, it might indicate the domain is on a compliance blocklist. Escalating to our team helps us investigate.


Most blocking issues can be resolved through configuration adjustments or by working with our team to whitelist specific domains.

Follow these guidelines to get the most out of your proxies and build more resilient automations.

1.  **Establish a Baseline Without Proxies**
    Before assuming you need a proxy for anti-bot measures, try accessing the target website without one. If Steel's default datacenter IPs work, you can save on costs. Use proxies as the next step if you encounter blocks.

2.  **Start with Broad Targeting**
    For the best performance, always start with country-level targeting. The larger IP pool provides higher quality and better success rates. Only use state or city-level targeting when it is a strict requirement for your use case.

3.  **Build Fallback Logic in Your Code**
    Proxy connections can sometimes fail (e.g., `ERR_TUNNEL_CONNECTION_FAILED`). This is normal. Your code should anticipate this by including retry logic. For critical tasks, consider having a fallback plan, such as retrying the request without a proxy or with a different proxy configuration.

4.  **Monitor Success Rates with Narrow Targeting**
    If you must use city-level targeting, closely monitor your job success rates. A high rate of failure could mean the local IP pool is too small or contains IPs that have been blocked or are of lower quality.

5.  **Test Different Regions for Blocked Content**
    If you're consistently blocked when targeting a specific country, try your request again from a different region. The target website may have different rules or restrictions for different geographic locations.

:::callout
type: help
### Need help building with proxies?
Reach out to us on the <span className="font-bold">#help</span> channel on [Discord](https://discord.gg/steel-dev) under the ⭐ community section.
:::


# Embed Sessions
URL: /overview/sessions-api/embed-sessions

---
title: Embed Sessions
sidebarTitle: Embed Sessions
description: Learn how to view and embed your live and past sessions.
llm: true
---

You can embed Steel sessions directly into your applications or dashboards to watch live browser activity or replay recorded sessions.

Steel supports two types of embeds:

<Cards>
  <Card
    title="Live Sessions"
    href="/overview/sessions-api/embed-sessions/live-sessions"
    description="Stream an active session in real time using WebRTC (headful by default)."
  />
  <Card
    title="Past Sessions"
    href="/overview/sessions-api/embed-sessions/past-sessions"
    description="Replay completed sessions as MP4/HLS video (or rrweb for legacy headless)."
  />
</Cards>

# Live Sessions
URL: /overview/sessions-api/embed-sessions/live-sessions

---
title: Live Sessions
sidebarTitle: Live Sessions
description: How to embed and share live browser sessions in your applications
llm: true
---

Steel sessions can be viewed live directly from your app or dashboard.  
With the new **headful experience**, live views now stream real-time video using WebRTC — low-latency, high-fidelity, and OS-accurate.

Legacy **headless sessions** continue to use the same debug URL but display content using Chrome’s screencasting for backward compatibility.

## Embed Headful Live Sessions (Recommended)

### What Changed
Steel’s live view now uses **WebRTC-based video streaming at 25 fps (H.264)**, replacing Chrome’s screencasting and screenshot-based method.

- Real-time OS-level capture  
- Stable 25 fps playback  
- Low-latency streaming with full visual fidelity  

> **Tip:** Headful sessions are now **default** for all new sessions.  
> You’ll use the same `debugUrl`, and Steel automatically chooses the proper playback technology.

---

### Getting the Debug URL

When creating a session with the API, the response includes a `debugUrl`.  
You can open this URL directly in your browser or embed it inside an application.

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
import { Steel } from "steel-sdk";

const client = new Steel({ apiKey: process.env.STEEL_API_KEY });
const session = await client.sessions.create();

console.log("Debug URL:", session.debugUrl);
```

```python !! Python -wcn
from steel import Steel

client = Steel()
session = client.sessions.create()
print("Debug URL:", session.debug_url)
```

</CodeTabs>

---

### Embedding in Your Application

Embed the session directly in your UI using an iframe:

```html
<iframe
  src="{session.debugUrl}?interactive=true"
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

- Streams real-time browser output using **WebRTC + H.264**  
- Works in all major browsers with baseline H.264 support  
- `interactive=true` allows remote mouse/keyboard input for collaborative debugging or human-in-the-loop workflows  

> **Note:** For security reasons, debug URLs are **unauthenticated**.  
> Anyone with the debug URL can view or interact with that session.  
> Use your own-access controls if embedding in a user-facing product.

---

### Supported Parameters (Headful)

| Parameter | Type | Default | Description |
|------------|------|----------|-------------|
| `interactive` | boolean | `true` | Enables or disables remote control of the live session. |

Example:

```html
<iframe
  src={`${session.debugUrl}?interactive=false`}
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

Disabling interactivity makes the view read-only, ideal for watch-only monitoring scenarios.

---

## Headless (Legacy)

> Headless live sessions remain supported for existing workflows.  
> They use Chrome’s screencasting instead of WebRTC and expose additional configuration options.

### Configuration Options (Headless Only)

| Parameter | Type | Default | Description |
|------------|------|----------|-------------|
| `theme` | string | `"dark"` | UI theme (`dark` or `light`) |
| `interactive` | boolean | `true` | Enable or disable interaction |
| `showControls` | boolean | `true` | Show or hide navigation UI |
| `pageId` | string | (empty) | Focus the view on a specific page/tab |
| `pageIndex` | string | (empty) | Display a specific tab by index |

Example:

```html
<iframe
  src={`${session.debugUrl}?theme=light&interactive=true&showControls=true&pageIndex=0`}
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

---

### Common Use Cases

**Read-only viewer**

```html
<iframe
  src={`${session.debugUrl}?interactive=false`}
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

**Human-in-the-loop control**

Allow humans to take over automation tasks or debug live workflows interactively using `interactive=true`.

---

### Troubleshooting

If the embedded view appears blank or unresponsive:
- Ensure the session is active (default timeout: 5 min).  
- Confirm your browser supports **H.264 baseline** playback.  
- Check your container has fixed dimensions (`width` and `height`).  
- Verify the correct session and valid API key were used.

---

### Summary

All new sessions now run **headful by default**, streaming real-time video with WebRTC.  
Use the same `debugUrl` to embed or view — Steel automatically determines the correct playback mode.  

Headless live streams remain available for legacy sessions but will be phased out over time.

# Past Sessions
URL: /overview/sessions-api/embed-sessions/past-sessions

---
title: Past Sessions
sidebarTitle: Past Sessions
description: How to access recordings of past browser sessions and display them within your app
llm: true
---

Steel automatically records every session so you can replay it later.  
With the new headful session recordings, you can now embed real MP4 playback — no event reconstruction, no missing UI elements.

For older implementations, we still support headless playback via rrweb.

## Embed Headful Session Recordings (Recommended)

### What Changed
Steel has moved from slow, unreliable screencasting and event-based playback to full OS-level streaming and MP4 recordings.

- 25fps WebRTC-based video streaming  
- MP4 recordings showing the exact screen output  
- No discrepancies between actual sessions and replays  

> **Tip:** Headful sessions are now **default** for all Steel sessions.  
> No changes are needed to your integration — this gives you direct control over embedding playback.

### Retrieving the Recording Playlist

<CodeTabs storage="languageSwitcher">

```typescript !! Typescript -wcn
const playlist = await fetch("https://api.steel.dev/v1/sessions/{session_id}/hls", {
  headers: {
    "steel-api-key": "YOUR_API_KEY"
  }
});
```

```python !! Python -wcn
import requests

url = "https://api.steel.dev/v1/sessions/{session_id}/hls"
headers = {
    "steel-api-key": "YOUR_API_KEY"
}
response = requests.get(url, headers=headers)
playlist = response.text
```

</CodeTabs>

This returns an HLS playlist that can be used in any compatible video player.

### Embedding in a Web Page

```html
<!doctype html>
<html>
  <body>
    <video id="player" controls playsinline style="width:100%;max-width:900px;"></video>

    <script type="module">
      import Hls from "https://cdn.jsdelivr.net/npm/hls.js@^1.5.0/dist/hls.mjs";
      const sessionId = "e4d682bb-a7f2-432c-ad13-8b116695d59e";
      const API_KEY = "YOUR_API_KEY";
      const manifestUrl = `https://api.steel.dev/v1/sessions/${sessionId}/hls`;
      const video = document.getElementById("player");

      if (Hls.isSupported()) {
        const hls = new Hls({
          xhrSetup: (xhr) => {
            xhr.setRequestHeader("steel-api-key", API_KEY);
          }
        });
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = manifestUrl;
      } else {
        video.outerHTML = "<p>Your browser does not support HLS.</p>";
      }
    </script>
  </body>
</html>
```

**Notes:**
- Works with any HLS-compatible player (e.g., Safari, HLS.js, JW Player, Video.js).  
- Recordings are durable MP4 streams for accurate, 1:1 playback.

## Headless

> Headless playback is supported for legacy sessions.  
> New sessions use headful replays for full visual fidelity — we recommend migrating when possible.

### Overview
Every Steel browser session records page events.  
You can fetch those events from the `/v1/sessions/:id/events` endpoint and replay them using `rrweb-player`.

### Retrieve the Recorded Events

**SDK Example**

```ts
const events = await client.sessions.events(session.id);
```

or

```python
events = client.sessions.events(session_id=session.id)
```

**Direct API**

```text
GET /v1/sessions/:id/events
```

### Replay with rrweb-player

**Install**
```bash
npm install rrweb-player
```

**Usage**
```ts
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";

const events = await client.sessions.events(session.id);
const playerElement = document.getElementById("player-container");

new rrwebPlayer({
  target: playerElement,
  props: {
    events: events,
    width: 800,
    height: 600,
    autoPlay: true,
    skipInactive: true
  }
});
```

**HTML**
```html
<div id="player-container"></div>
```

---

### Summary
All new sessions now run **headful by default**.  
Headless event-based playback remains available for legacy recordings but will be deprecated in the future.  
Use headful recordings for the most accurate, reliable replays.
