# steel-vertical-analysis

# Steel GTM Vertical Analysis

> Living document for vertical prioritization, lead identification, discovery call prep, and competitive intelligence. Updated continuously. New companies and use cases will be added over time via research agents.
> 

**Last Updated:** 2026-02-14

---

## How to Use This Document

| If you need to… | Go to… |
| --- | --- |
| Find leads in a specific vertical | That vertical’s **Target Companies** section |
| Prep for a discovery call | That vertical’s **Use Cases** — understand what problems browser infra solves here |
| Understand what competitors are winning | That vertical’s **Competitive Intelligence** table |
| Decide which vertical to prioritize | **Vertical Prioritization Matrix** below |
| Find use cases at a specific complexity | Search for `[SCRAPE]`, `[SESSION]`, `[RESEARCH]`, or `[AGENT]` tags |
| Log a new use case that doesn’t fit | **Miscellaneous & Emerging** section at the bottom |

---

## Complexity Tier Legend

These tags appear next to every use case to indicate the minimum Steel product required. This matters for GTM because it signals deal size, sales motion, and whether a prospect could “just use a scrape endpoint” vs. truly needing Steel’s full browser infrastructure.

| Tag | Steel Product | What It Means | Implication |
| --- | --- | --- | --- |
| `[SCRAPE]` | Scrape API | Static data extraction, no login, no interaction | Low ACV, self-serve, high volume. Risk: commoditized, Firecrawl territory. |
| `[SESSION]` | Sessions API (Headless Browser) | Authenticated sessions, cookie persistence, multi-step navigation | Mid ACV, self-serve to sales-assisted. Our bread and butter. |
| `[RESEARCH]` | Deep Research API | Multi-source synthesis, deep web traversal, report generation | Mid ACV, often paired with other tiers. Parallel.ai territory for simpler cases. |
| `[AGENT]` | Full Browser Agent | Full browser control, form filling, portal automation, CUA workflows | High ACV, sales-led. Steel’s strongest differentiation. |

---

## Vertical Prioritization Matrix

| # | Vertical | Steel Customers | Competitor Intel | Signal Strength | Primary Tier | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Healthcare Agents | 5 | 4 | Strong | `[AGENT]` | **P0** |
| 2 | Sales & Marketing Intelligence | 1 | 6 | Strong | `[RESEARCH]` / `[AGENT]` | **P0** |
| 3 | Financial Services Agents | 0 | 3 | Strong | `[AGENT]` | **P1** |
| 4 | Accounting & Financial Ops | 0 | 1 | Medium | `[AGENT]` | **P1** |
| 5 | Legal & Compliance Agents | 0 | 1 | Medium | `[AGENT]` | **P1** |
| 6 | Logistics & Supply Chain | 3 | 1 | Medium | `[SESSION]` / `[AGENT]` | **P1** |
| 7 | Customer Service & Support | 0 | 3 | Medium | `[SCRAPE]` | **P2** |
| 8 | Developer Tools & QA | 0 | 3 | Medium | `[SCRAPE]` / `[SESSION]` | **P2** |
| 9 | E-Commerce & Marketplace | 0 | 5 | Strong | `[AGENT]` | **P2** |
| 10 | Knowledge Base & Content Intelligence | 0 | 5+ | Strong | `[SCRAPE]` | **P2** |
| 11 | Security & Compliance | 0 | 0 | Emerging | `[SESSION]` | **P3** |
| 12 | Workflow Automation & RPA | 0 | 1 | Medium | `[AGENT]` | **P2** |
| 13 | AI Training & RL Environments | 0 | 0 | Emerging | `[SESSION]` | **P3** |
| 14 | Non-Profit & Government | 0 | 2 | Emerging | `[AGENT]` | **P3** |
| 15 | Miscellaneous & Emerging | — | — | — | — | — |

---

## 1. Healthcare Agents

> Payer portals are notoriously fragmented with no standard APIs. Workflows require authenticated sessions, file uploads, and multi-step navigation — making full browser automation essential. HIPAA considerations make DIY browser infra risky; outsourcing to specialized infra is cleaner.
> 

### Use Cases

- **Prior Authorization Submission & Tracking** `[AGENT]` — AI agents log into insurer portals (UHC, Aetna, Cigna, Humana, BCBS) to submit prior-auth forms, upload clinical documents, and poll for determination status. The most common healthcare automation use case — every clinic and specialty pharmacy deals with this. *Ref: Novoflow (Kernel) — [source](https://www.kernel.sh/blog/novoflow); Commure (Browserbase) — [source](https://www.browserbase.com/blog/case-study-commure)*
- **Eligibility & Benefits Verification** `[AGENT]` — Agents navigate payer web portals to verify patient coverage, check benefit limits, and confirm drug formulary status in real-time before appointments or prescriptions. Often paired with PA workflows.
- **EHR/EMR Web UI Automation** `[AGENT]` — ~80% of the ~400 EHR/EMR systems have little to no API access. Agents must interact with EHR web interfaces (Epic, Athena, Cerner) to pull patient data, update charts, schedule appointments, or trigger workflows. *Ref: Novoflow (Kernel) — [source](https://www.kernel.sh/blog/novoflow)*
- **Claims Denial Management & Appeals** `[AGENT]` — Agents log into payer portals to retrieve denial reasons, compile appeal packets, and submit appeals with supporting clinical documentation. Multi-step workflows with file upload requirements.
- **Revenue Cycle Management (RCM)** `[AGENT]` — Automating claim status inquiries by continuously logging into dozens of insurer claim portals, Medicare/Medicaid systems, and web-based billing tools that lack APIs. *Ref: Commure (Browserbase) processes 20x more claims daily with browser automation — [source](https://www.browserbase.com/blog/case-study-commure)*
- **Patient Intake & Referral Processing** `[AGENT]` — Digitizing inbound referrals, extracting patient info from faxes/portals, verifying eligibility, and auto-populating intake forms across systems. *Ref: Felicity (Kernel) — [source](https://www.kernel.sh/blog/felicity)*
- **Provider Credentialing & Licensing** `[AGENT]` — Bots log into government licensing sites, CAQH, and insurer credentialing portals to auto-fill/submit provider info and monitor for status updates.
- **Copay Assistance & Patient Financial Programs** `[SESSION]` — Navigating manufacturer copay card sites, patient assistance program portals, and specialty pharmacy benefit hubs to enroll patients and track assistance status.
- **Regulatory Compliance Monitoring** `[SESSION]` — Monitoring state health department portals, CMS updates, and regulatory sites for policy changes affecting operations.
- **Provider Network Data Aggregation** `[SCRAPE]` / `[SESSION]` — Collecting and normalizing provider information (directories, specialties, locations, accepting-new-patients status) from thousands of healthcare organization portals that each have different structures. *Ref: TinyFish Healthcare — [source](https://www.tinyfish.ai/enterprise/healthcare)*
- **Real-time Appointment Slot Discovery** `[SESSION]` / `[AGENT]` — Monitoring hospital and clinic scheduling portals to surface available appointment slots across fragmented provider networks in real-time. Positioned as replacing “$10M+ API work” through portal automation. *Ref: TinyFish Healthcare — [source](https://www.tinyfish.ai/enterprise/healthcare)*

### Target Companies

**Steel Customers:**

| Company | Notes |
| --- | --- |
| Distyl (distyl.ai) | - |
| Autonomize (autonomize.ai) | - |
| Magical | Existing customer |
| Exponentialcare.ai | Existing customer |
| GoodLabs | Existing customer |

**Dream Targets:**

| Company | Domain | Stage | What They Do | Primary Use Case |
| --- | --- | --- | --- | --- |
| Latent Health | latenthealth.com | Series B | Clinical AI for prior-auth in specialty pharmacy | PA workflow automation across insurer/PBM portals |
| Tandem Health | withtandem.com | Series A | End-to-end prescription access (PA, appeals, copay) | Payer portal automation for every prescription |
| Mandolin | mandolin.com | Series A ($40M) | AI back-office for specialty therapies | “No APIs. No integrations. Every step, fully automated.” |
| Squad Health | squadhealth.ai | Seed ($7M) | AI non-dispensing pharmacy for clinics | Engineering stack uses Selenium — strong replacement signal |
| Silna Health | silnahealth.com | Series A | Insurance clearance across 1000+ payors | Continuous payer portal automation |
| Tennr | tennr.com | Series C ($101M) | Patient intake & referral automation | Eligibility checks + PA submissions via portal automation |
| Develop Health | develophealth.ai | Series A ($14.3M) | EHR-embedded prescription clearance | Real-time payer portal PA submission |
| Foundation Health | foundationhealth.com | Series A ($20M) | AI pharmacy ops (PA, benefits, billing) | “PAIGE AI” automates PA across medical/pharmacy benefits |
| Medallion | medallion.co | Series C (~$130M) | Provider credentialing & licensing | Bots for government licensing sites, CAQH, insurer portals |
| Cohere Health | coherehealth.com | Series B/C (~$106M) | Prior-auth platform connecting providers & payers | Portal automation where direct payer APIs unavailable |
| AKASA | akasa.com | Series B (~$100M) | AI revenue cycle automation for hospitals | Claim status bots logging into dozens of insurer portals |

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Novoflow | Kernel | Voice AI agents automating EHR tasks (booking, refills, scheduling) for clinics lacking APIs. Migrated from Scrapybara in 2 days. | [kernel.sh/blog/novoflow](https://www.kernel.sh/blog/novoflow) |
| Felicity | Kernel | AI-native RPA for healthcare — inbound referrals, chart updates, credentialing. 2x faster than previous provider. MP4 video replays for audit trails. | [kernel.sh/blog/felicity](https://www.kernel.sh/blog/felicity) |
| Commure | Browserbase | HIPAA-compliant claims reconciliation across payer portals. Scout product processes 20x more claims daily; 8,000+ hours automated in 3 months. | [browserbase.com/blog/case-study-commure](https://www.browserbase.com/blog/case-study-commure) |
| TinyFish (vertical) | TinyFish | Healthcare vertical page describes portal-based patient journey coordination, provider network aggregation across 1000s of portals, and claims/RCM automation. Positioned as replacing “$10M+ API work.” | [tinyfish.ai/enterprise/healthcare](https://www.tinyfish.ai/enterprise/healthcare) |

### Notes

- Payer portal fragmentation is the structural moat here — there are hundreds of payers, each with their own web portal, and no universal API. This isn’t going away.
- HIPAA compliance positioning matters. Companies explicitly cite “outsourcing browser infra is cleaner than DIY” for compliance reasons.
- Squad Health’s explicit use of Selenium is a strong signal — they’re already doing browser automation with legacy tools and would benefit from modern infra.
- Mandolin’s “No APIs. No integrations.” messaging is exactly the problem Steel solves.
- This is overwhelmingly an `[AGENT]` vertical — almost no use cases here can be served by a simple scrape endpoint. High ACV territory.

---

## 2. Sales & Marketing Intelligence

> Sales and marketing AI agents need to pull info from a non-deterministic set of sites across the web. Critical data sources (LinkedIn, company sites, job boards) lack stable APIs. Workflows require login, navigation, scrolling, retries, and human-like behavior. Scale + reliability matter — missed data = bad personalization.
> 

### Use Cases

- **Automated Prospect & Account Research** `[RESEARCH]` / `[AGENT]` — AI agents crawl company websites, LinkedIn profiles, news articles, job boards, and niche sources to build rich prospect profiles. Often 1,000+ data points per account. The foundation of every modern sales intelligence tool. *Ref: Aomni (Browserbase) — [source](https://www.browserbase.com/blog/case-study-aomni)*
- **Web-Based Lead Enrichment** `[SCRAPE]` / `[SESSION]` — Extracting structured data from company websites, LinkedIn, Crunchbase, job postings, tech stacks, and review sites to enrich CRM records. Can be scrape-tier for public pages but often requires sessions for LinkedIn or authenticated sources. *Ref: PromptLoop (Browserbase) crawls hundreds of thousands of sites monthly — [source](https://www.browserbase.com/blog/case-study-promptloop); Structify (Browserbase) — [source](https://www.browserbase.com/blog/case-study-structify)*
- **Converting Websites into Structured Lead Lists** `[AGENT]` — Agents adaptively navigate websites, use search, and iteratively refine scraping strategies to transform unstructured web data into qualified lead databases. Requires dynamic logic, not just static scraping. *Ref: Orange Slice (Kernel) — [source](https://www.kernel.sh/blog/orangeslice)*
- **GEO/AEO Monitoring (AI Search Optimization)** `[AGENT]` — Monitoring how brands appear in ChatGPT, Perplexity, Gemini, and other LLM answer engines by running real prompts through actual browser UIs (API responses differ from UI results). Requires massive scale — 50K+ browser sessions/month. *Ref: The Prompting Company (Kernel) runs 50,000+ browsers monthly — [source](https://www.kernel.sh/blog/thepromptingcompany)*
- **Sales Trigger Detection** `[SCRAPE]` / `[SESSION]` — Continuous monitoring of job boards, funding announcements, leadership changes, tech adoption signals, and company news to surface buying intent in real-time.
- **Multi-Channel Outbound Automation** `[AGENT]` — AI SDRs/BDRs that operate across LinkedIn, email, and social channels — performing actions like sending connection requests, viewing profiles, engaging with posts, and sequencing follow-ups. Requires persistent browser sessions with identity/cookie management.
- **Competitive Intelligence & Account Monitoring** `[SESSION]` / `[RESEARCH]` — Ongoing crawling of competitor websites, pricing pages, product changelogs, review sites, and job postings to track competitive moves and account changes.
- **Community & Intent Signal Scraping** `[SCRAPE]` / `[SESSION]` — Monitoring Reddit, Hacker News, GitHub, forums, and social platforms to surface buying intent signals and identify prospects in active evaluation cycles.
- **Event & Conference Lead Extraction** `[AGENT]` — Navigating event and conference websites to extract attendee, speaker, and sponsor data for lead generation. Each event site has different structure — agents must adapt without re-engineering. *Ref: Amplemarket (TinyFish) — [source](https://www.tinyfish.ai/customers/amplemarket)*
- **Programmatic SEO & Content Generation at Scale** `[SCRAPE]` / `[SESSION]` — Crawling competitor content, analyzing SERP results, and generating/updating pages programmatically. Often requires understanding how content renders in browsers (not just raw HTML).
- **AEO-Readiness Scanning / AI Visibility Signal Detection** `[SCRAPE]` / `[SESSION]` — Crawling prospect websites at scale to detect AI-readiness signals that standard enrichment tools (Clay, ZoomInfo, Clearbit) can’t surface: presence/quality of llms.txt files (~10% adoption), robots.txt rules for AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended), Schema.org/JSON-LD structured data (requires JS rendering), FAQ schema markup, blog publish velocity, sitemap freshness, and CMS/marketing stack detection from rendered HTML. Composite scoring produces an “AEO-readiness” profile per domain that drives outbound prioritization. Analogous to Vercel’s “Prism” system but tuned for marketing/AEO signals rather than framework adoption. *Ref: Vercel (Browserbase) built “Prism” for tech stack intelligence at scale — [source](https://www.browserbase.com/blog/case-study-vercel)*
- **G2 & Review Site Competitive Intelligence Mining** `[SESSION]` — Scraping competitor reviews on G2, Capterra, TrustRadius and other review platforms to extract structured pain points, feature gaps, switching triggers, and objection patterns. G2 is JS-heavy and login-gated for full review text, requiring browser sessions. Output feeds battlecards, competitive positioning, and “why switch” content.
- **Personalized AI Search Demo Recordings for Outbound** `[AGENT]` — Recording live Steel browser sessions where an agent opens ChatGPT/Perplexity/Google AI Overviews, types a query a prospect’s customer would ask, and captures the real-time AI response on video — showing who gets cited and who doesn’t. The recording becomes a personalized outbound asset (“watch your competitor get recommended while you’re invisible”). Requires real browser with visible UI + session recording. API responses differ from UI responses, so headless/API scraping cannot replicate this. Video pipeline: Steel session recording → upload to Vidyard/Loom/S3 → embed in outbound email. Particularly relevant for AEO/GEO companies (Profound, AthenaHQ) but applicable to any company selling visibility/monitoring.
- **Competitive Category Gap Outbound** `[SCRAPE]` / `[AGENT]` — Building prospect lists by category (via G2 categories, conference sponsor lists, industry directories), then running AI search queries to rank companies by visibility within each category, and targeting the “losers” with data-backed outbound showing the gap between them and their competitors. The data is the pitch — “your competitor ranks #1 for [query] in ChatGPT, you’re at #5.” Combines list-building (`[SCRAPE]`) with AI engine querying (`[AGENT]`). Scales per-category as a repeatable motion.

### Target Companies

**Steel Customers:**

| Company | Notes |
| --- | --- |
| PipeRich | Existing customer |

**Dream Targets:**

| Company | Domain | Stage | What They Do | Primary Use Case |
| --- | --- | --- | --- | --- |
| Clay | clay.com | Series C | AI web research at scale (Claygent) | Agents crawling company sites, LinkedIn, job boards, news for enrichment |
| Attio | attio.com | Series B | AI-native CRM with continuous enrichment | Background crawling of LinkedIn, company pages, news for CRM agents |
| Profound | tryprofound.com | Series B | AI search / answer engine optimization | Queries ChatGPT, Perplexity, Google AI — tracks brand presence at scale |
| AirOps | airops.com | Series B | Generative SEO + AI search optimization | Large-scale browsing of AI results + CMS interactions |
| AthenaHQ | athenahq.ai | Seed | GEO platform tracking brand visibility in LLMs | Massive prompt/query matrices across AI engines |
| 11x | 11x.ai | Series B | AI SDRs (Alice) | Prospect research, LinkedIn activity, email workflows, CRM updates |
| Artisan | artisan.co | Series A | AI BDR (Ava) | Scrapes job postings, funding news, LinkedIn changes for real-time outreach |
| Regie.ai | regie.ai | Series B | Agentic outbound platform | Prospecting, enrichment, LinkedIn/email engagement |
| Warmly | warmly.ai | Series A | De-anonymization + intent signals + auto-engagement | Web monitoring + social automation |
| Bluebirds | bluebirds.com | Acquired | Signal-driven prospecting | Continuous crawling of news, job boards, LinkedIn-like sources |
| Humantic AI | humantic.ai | Seed | Personality inference from digital footprints | Browser-based scraping of LinkedIn profiles and social presence |
| Onfire | onfire.ai | Series A | Buying intent from communities | Crawling Reddit, HN, GitHub, forums + identity resolution |
| Common Room | commonroom.io | Series B | GTM intelligence from community + web signals | Agent-driven ingestion of public web data from Slack, GitHub, forums |
| Unify | unifygtm.com | Series B | GTM platform | — |

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| The Prompting Company | Kernel | LLM analytics monitoring real UI responses at scale — 50K+ browsers/month. API responses don’t match UI, so full browser sessions required. Uses profiles for cookie/session persistence. | [kernel.sh/blog/thepromptingcompany](https://www.kernel.sh/blog/thepromptingcompany) |
| Orange Slice | Kernel | Transforms unstructured websites into qualified lead databases. Agents adaptively navigate, search, and refine scraping strategies. Uses stealth mode, Playwright execution, browser pools. | [kernel.sh/blog/orangeslice](https://www.kernel.sh/blog/orangeslice) |
| Aomni | Browserbase | AI sales intelligence analyzing 1,000+ data points per account. Saves 3 hours per prospect. Uses unified browsing + proxy infra for low-latency research. | [browserbase.com/blog/case-study-aomni](https://www.browserbase.com/blog/case-study-aomni) |
| PromptLoop | Browserbase | Large-scale website analysis for mid-market sales teams. 10,000+ rows simultaneously, 95%+ success rate. Hundreds of thousands of sites monthly. Replaced self-managed ECS. | [browserbase.com/blog/case-study-promptloop](https://www.browserbase.com/blog/case-study-promptloop) |
| Structify | Browserbase | AI agents structuring web information into enterprise datasets. Scales to thousands of concurrent sessions. RAM usage went from gigabytes to near-zero by offloading to hosted browsers. | [browserbase.com/blog/case-study-structify](https://www.browserbase.com/blog/case-study-structify) |
| Amplemarket | TinyFish | Automated conference/event lead data extraction from event websites. Zero-maintenance adaptability to changing layouts. Dozens of events processed monthly. | [tinyfish.ai/customers/amplemarket](https://www.tinyfish.ai/customers/amplemarket) |

### Notes

- This vertical spans the full complexity spectrum from `[SCRAPE]` (basic enrichment) to `[AGENT]` (LinkedIn automation, GEO monitoring). The highest-value use cases are `[AGENT]`tier.
- GEO/AEO monitoring is a rapidly growing sub-segment. The Prompting Company’s 50K browsers/month signals massive scale requirements. Profound and AthenaHQ are in the same space.
- The Sales & Marketing vertical has extremely active Seed–Series B ecosystem with strong willingness to pay for infra that unlocks differentiation.
- LinkedIn-adjacent use cases (enrichment, outbound, monitoring) are particularly sticky because LinkedIn aggressively blocks scrapers — reliable browser infra with stealth is a hard requirement.
- **AEO-readiness scanning is an emerging high-value use case** — detecting llms.txt, AI crawler rules in robots.txt, and rendered-page structured data requires real browser sessions and is outside the reach of standard enrichment APIs. This is a “Prism-style” play (cf. Vercel case study) specifically for AEO/GEO companies like Profound, AthenaHQ, and AirOps. llms.txt adoption is ~10% of major domains as of early 2026, making it a differentiating signal for now.
- G2 review scraping is underrated as a use case — it’s `[SESSION]`tier (JS rendering + auth for full text) and produces high-value competitive intelligence. Relevant for any company in a competitive SaaS category.
- **Personalized video outbound using Steel session recordings** is a novel use case pattern: record a real browser session as a demo/proof-of-concept, then use the recording as a sales asset. This is unique to managed browser infra with recording capabilities — it’s not a scraping use case but a “browser-as-camera” use case. Applicable beyond AEO (e.g., any company that wants to show a prospect something happening live on the web).
- **Competitive gap outbound** (use your own product’s data to find prospects who need your product) is a powerful meta-pattern for any Steel customer in the intelligence/monitoring space. The product becomes the prospecting engine.

---

## 3. Financial Services Agents

> Financial services relies heavily on government/regulator websites (SEC, state registries), insurer/bank portals with login + forms, and multi-step workflows involving document upload/download. “Data aggregation” claims where APIs are clearly incomplete are a strong signal for browser infra needs.
> 

### Use Cases

- **SEC & Regulatory Filing Retrieval** `[SCRAPE]` / `[SESSION]` — Fetching filings from EDGAR, state registries, and global corporate databases. Simpler filings are scrape-tier, but authenticated or rate-limited sources require sessions.
- **Investment Due Diligence & Research** `[RESEARCH]` / `[AGENT]` — AI agents synthesizing company data from SEC filings, earnings transcripts, data rooms, investor decks, news, and corporate registries to generate models, comps, and diligence reports. Multi-source traversal is core. *Ref: Parcha (Browserbase) reduces due diligence from hours to 3-4 minutes — [source](https://www.browserbase.com/blog/case-study-parcha)*
- **Private Market Intelligence** `[SESSION]` / `[RESEARCH]` — Aggregating alternative data (web traffic, hiring signals, reviews, company sites, state registries) for PE/VC investment decisions. Continuous crawling across fragmented sources.
- **KYC/AML Identity & Business Verification** `[SESSION]` / `[AGENT]` — Checking identities and businesses against sanctions lists, government registries, adverse media, and corporate ownership databases. Many of these are web portals with no APIs. *Ref: Parcha (Browserbase) — [source](https://www.browserbase.com/blog/case-study-parcha)*
- **Insurance Underwriting Intelligence** `[AGENT]` — Crawling SMB websites, state registries, reviews, and licensing databases to build risk profiles for commercial insurance underwriting decisions.
- **Employment & Income Verification** `[AGENT]` — Credential-based access to payroll/HR portals (ADP, Workday, gig platforms) to verify employment history and income for lending or compliance.
- **Corporate Ownership & Registry Intelligence** `[SESSION]` — Crawling state and international corporate registries (many with no APIs) to map ownership structures, beneficial ownership, and entity relationships.
- **Competitive Rate & Product Intelligence** `[SESSION]` / `[AGENT]` — Monitoring competitor pricing, rates, and product offerings across financial platforms in real-time. Includes navigating multi-step insurance quote forms and carrier portals for rate comparison — replacing manual re-keying of PDF data. *Ref: TinyFish Financial Services — [source](https://www.tinyfish.ai/enterprise/financial-services)*
- **Real-time Regulatory Filing Monitoring** `[SESSION]` — Continuous tracking of regulatory filings, policy changes, and compliance requirements across financial and government sites. Goes beyond one-time retrieval to ongoing monitoring with alerting. *Ref: TinyFish Financial Services — [source](https://www.tinyfish.ai/enterprise/financial-services)*
- **Financial Data Extraction from Portals** `[AGENT]` — Automating access to merchant portals, financial institution dashboards, and government benefit systems to extract transaction data, balances, and account information. *Ref: Benny (Browserbase) automates SNAP/EBT portal access — maintenance dropped from 4-5 hrs/week to 15 min; merchant onboarding cut 90% — [source](https://www.browserbase.com/blog/case-study-benny), [2024 update](https://www.browserbase.com/blog/case-study-benny-2024)*

### Target Companies

**Dream Targets:**

| Company | Domain | Stage | What They Do | Primary Use Case |
| --- | --- | --- | --- | --- |
| Harmonic | harmonic.ai | Series C | AI startup/company intelligence for investors & GTM | Scraping SEC filings, company sites, LinkedIn, hiring pages, news |
| Hebbia | hebbia.com | Series B | AI research & diligence copilot for PE/VC/banks | EDGAR, earnings transcripts, data rooms, PDFs, investor sites |
| Rogo | rogo.ai | Series B | AI agents for IB & deal teams | SEC filings, global registries, investor decks, news |
| Synaptic | synaptic.com | Series B | Private-market intelligence for PE/VC | Web traffic, hiring, reviews, company sites, registries |
| FinChat | finchat.io | Seed/Series A | AI copilot for public-market research | SEC filings, earnings transcripts, IR pages |
| Wokelo | wokelo.ai | Seed | GenAI diligence for PE/Corp Dev | Company sites, registries, news, PDFs, data rooms |
| Dili | dili.ai | Seed | Automated investment due diligence | Public records, filings, news, agent workflows |
| Planck | planckdata.com | Series B | Commercial insurance underwriting intelligence | Crawls SMB websites, state registries, reviews, licensing DBs |
| Argyle | argyle.com | Series B | Employment & income verification via portal access | ADP, Workday, gig platform automation — browser automation is core IP |
| Sigma Ratings | sigma360.com | Series A | AI risk & AML intelligence | Sanctions lists, registries, adverse media across govt/foreign sites |
| Sayari | sayari.com | Series B/C | Global corporate ownership & registry intelligence | State + international registries with no APIs — heavy headless browser usage |

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Parcha | Browserbase | Enterprise AI agents for banking compliance and customer onboarding. Due diligence reduced from hours to 3-4 minutes. Comprehensive business view in 10 seconds. | [browserbase.com/blog/case-study-parcha](https://www.browserbase.com/blog/case-study-parcha) |
| Benny | Browserbase | Platform serving 42M SNAP recipients. Automates financial data extraction from merchant/EBT portals lacking APIs. ~40% improvement in link success rate. Maintenance dropped from 4-5 hrs/week to 15 min/week. | [browserbase.com/blog/case-study-benny-2024](https://www.browserbase.com/blog/case-study-benny-2024) |
| TinyFish (vertical) | TinyFish | Financial services vertical page describes competitive rate intelligence, accelerated insurance policy quoting via carrier portals (50% quote time reduction), and real-time regulatory monitoring. | [tinyfish.ai/enterprise/financial-services](https://www.tinyfish.ai/enterprise/financial-services) |

### Notes

- Finance sub-segments have very different buyers: Market Intelligence sells to investors/analysts, KYC/AML sells to compliance teams, Insurance sells to underwriters. Tailor positioning accordingly.
- Argyle is notable — their entire business model is credential-based portal access via browser automation. This is a “browser infra is core IP” signal.
- Sayari and Sigma Ratings are crawling government registries globally — many of these registries are notoriously difficult to scrape (rate limits, CAPTCHAs, session requirements).
- The split between Financial Services and Accounting/Ops (next section) reflects different ICPs and sales cycles.

---

## 4. Accounting & Financial Ops

> Accounting and financial operations teams interact with bank portals, vendor invoice sites, state tax portals, and legacy accounting UIs. When feeds break or APIs don’t exist, browser automation fills the gap. The buyer here is the CFO/controller or accounting firm, not a financial institution.
> 

### Use Cases

- **State Tax Portal Filing & Compliance** `[AGENT]` — Automating access to 48+ state tax portals for sales tax registration, filing, and payment. Each portal has different login flows, 2FA, and form structures. *Ref: Numeral (Browserbase) replaced manual Playwright scripting with AI-driven portal automation — [source](https://www.browserbase.com/blog/numeral-automates-sales-tax)*
- **Vendor Portal Invoice Retrieval** `[SESSION]` / `[AGENT]` — Logging into vendor billing portals, utility company dashboards, and merchant sites to download invoices, reconcile charges, and process AP workflows.
- **Bank Portal Automation** `[AGENT]` — Accessing bank web interfaces for statement downloads, transaction verification, balance checks, and reconciliation when direct feeds/APIs are unavailable or unreliable.
- **Expense & Payment Verification** `[SESSION]` — Checking payment status, verifying transactions, and reconciling data across multiple financial web portals.
- **Payroll Portal Data Extraction** `[SESSION]` / `[AGENT]` — Pulling data from ADP, Gusto, Paylocity, and other payroll platform web UIs for accounting reconciliation.

### Target Companies

**Dream Targets:**

| Company | Domain | Stage | What They Do | Primary Use Case |
| --- | --- | --- | --- | --- |
| Basis | getbasis.ai | Series A | Autonomous AI agents for accounting firms | Bank portals, vendor sites, legacy accounting UIs |
| Botkeeper | botkeeper.com | Series C | AI-driven bookkeeping for accounting firms | Bank logins, payroll portals, merchant dashboards |
| Vic.ai | vic.ai | Series B | Autonomous AP & invoice processing | Vendor portals, billing sites, ERP web UIs |

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Numeral | Browserbase | Automated sales tax compliance across 48 state portals. Uses Stagehand (AI) instead of manual Playwright scripts. Handles credential verification, 2FA, and filing submissions. | [browserbase.com/blog/numeral-automates-sales-tax](https://www.browserbase.com/blog/numeral-automates-sales-tax) |

### Notes

- State tax portal automation is a great wedge use case — highly specific, clearly painful, and requires `[AGENT]`tier capabilities. Numeral validates this.
- The accounting vertical is less “sexy” than financial services but has a massive SMB/mid-market TAM (every business files taxes, pays vendors, reconciles bank statements).
- Basis explicitly mentions “when APIs fail” as the trigger for browser automation — this is the positioning angle.

---

## 5. Legal & Compliance Agents

> Legal workflows often depend on government portals, court systems, regulatory databases, and case management platforms that are web-only with no API access. Monitoring these portals for updates is tedious, manual, and high-stakes.
> 

### Use Cases

- **Government Portal Monitoring** `[SESSION]` / `[AGENT]` — Automated daily checks of government websites, court systems, and regulatory databases for case updates, filing deadlines, and new documents. *Ref: Chronicle Legal (Browserbase) runs 100,000+ sessions monthly monitoring government portals — [source](https://www.browserbase.com/blog/case-study-chronicle)*
- **Court Filing & Document Retrieval** `[AGENT]` — Navigating PACER, state court e-filing systems, and other legal databases to submit filings, download case documents, and track docket changes.
- **Regulatory Compliance Monitoring** `[SESSION]` — Crawling state and federal regulatory sites for policy updates, new rules, and compliance requirement changes across jurisdictions.
- **Evidence & Document Collection** `[SESSION]` / `[AGENT]` — Gathering evidence from web sources, social media, public records, and government databases for litigation support.
- **Corporate Legal Research** `[RESEARCH]` — Multi-source synthesis of case law, regulatory guidance, corporate filings, and legal precedents from various web-based legal databases.
- **Provider/Entity Credentialing** `[AGENT]` — Submitting and tracking applications across state licensing boards, professional certification bodies, and regulatory agencies (overlaps with Healthcare).

### Target Companies

*No Steel customers or specific dream targets identified yet for this vertical. Companies from the spreadsheet’s “Legal & Case Ops Agents” category to be researched and added.*

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Chronicle Legal | Browserbase | Evidence monitoring for disability attorneys. 100,000+ sessions/month checking government portals for case updates. Single founder scaled without months of dev work. Migrated from self-hosted Selenium Grid. | [browserbase.com/blog/case-study-chronicle](https://www.browserbase.com/blog/case-study-chronicle) |

### Notes

- Chronicle Legal is a compelling case study: single-founder company running 100K+ sessions/month. Shows that even small legal tech companies have massive browser automation needs.
- The migration-from-Selenium signal is strong here — legal tech companies often start with DIY automation and hit scaling walls.
- Government portals are notoriously difficult (session timeouts, CAPTCHAs, inconsistent UIs) — stealth and session management are critical.

---

## 6. Logistics & Supply Chain

> Logistics portals are highly fragmented and rarely API-first. Workflows are multi-step, authenticated, and failure-sensitive. High-volume ops require retries, resilience, and observability. Browser infra is core to product reliability, not a side feature.
> 

### Use Cases

- **Load Booking on Broker Boards** `[AGENT]` — Automating load search, evaluation, and booking on platforms like DAT and Truckstop that require authenticated sessions and complex multi-step interactions.
- **Shipper & Carrier Portal Operations** `[AGENT]` — Executing shipment-related tasks across dozens of fragmented shipper and carrier portals — order entry, dispatch, status updates, rate confirmations. Each portal has unique UI and workflow.
- **Procurement & Checkout Automation** `[AGENT]` — Replacing legacy “punchout” integrations with AI-powered browser automation for materials procurement across supplier websites. *Ref: Silkline (Kernel) achieved 80% reduction in checkout effort — [source](https://www.kernel.sh/blog/silkline)*
- **Document Upload/Download (BOLs, PODs, Invoices)** `[SESSION]` / `[AGENT]` — Uploading and downloading bills of lading, proof of delivery, rate confirmations, and invoices across carrier, broker, and shipper portals.
- **Claims & Disputes** `[AGENT]` — Submitting and tracking detention, damage, and accessorial claims across carrier/broker portals. Multi-step workflows with evidence upload requirements.
- **Invoice Submission & Payment Reconciliation** `[SESSION]` / `[AGENT]` — Submitting invoices through shipper/broker portals and checking payment status across factoring and payment platforms.
- **Customs & Government Portal Compliance** `[AGENT]` — Interacting with customs systems, government import/export portals, and regulatory compliance sites for freight forwarding documentation.

### Target Companies

**Steel Customers:**

| Company | Notes |
| --- | --- |
| Melrose | Existing customer |
| Zauber | Existing customer |
| usecervo.com | Existing customer |

**Dream Targets:**

| Company | Domain | Stage | What They Do | Primary Use Case |
| --- | --- | --- | --- | --- |
| HappyRobot | happyrobot.ai | Series B | AI workers for logistics ops (brokers/forwarders/carriers) | Shipper/carrier portal automation + doc workflows |
| Pallet | pallet.com | Series B | AI logistics OS with CoPallet agent | Portal updates (order entry → dispatch → billing) |
| Magentic | magentic.com | Seed | AI agents for procurement/supply chain | Procurement/supplier portals + ERP web UIs |
| Augment (Augie) | goaugment.com | Series A | AI teammate for freight ops | Broker/shipper portals + load boards |
| Hwy Haul | hwyhaul.com | Series A | Digital broker + AI TMS | Load boards + compliance + shipper portals |
| Bear Cognition | bearcognition.com | Early/Growth | Automation overlay for brokers/3PLs | Quoting, BOL creation, check calls, billing audits |
| Alvys | alvys.com | Series B | Modern TMS for carriers/brokers | Long-tail portals not covered by APIs |
| Freightmate AI | freightmate.ai | Seed | AI for freight forwarding/customs docs | Carrier portals + customs/gov portals + legacy TMS web UIs |
| SmartHop | smarthop.com | Series B | AI dispatch for small fleets | DAT/Truckstop + broker portals + doc uploads |

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Silkline | Kernel | AI-powered procurement checkout replacing legacy “punchout” integrations. 80% reduction in checkout effort. Implementation from 6 weeks to 10 minutes. Browser pause/resume during 48-hour approval windows. Audit-ready replay. | [kernel.sh/blog/silkline](https://www.kernel.sh/blog/silkline) |

### Notes

- Logistics is dominated by `[AGENT]`tier use cases. The fundamental problem is hundreds of fragmented portals with no standardization.
- Silkline’s “pause/resume during 48-hour approval windows” is a distinctive feature need — long-lived browser sessions with state persistence.
- The freight/logistics ecosystem has a clear “too many tabs” problem that maps directly to browser automation value prop.
- HappyRobot and Pallet are the strongest anchor targets — both are AI-first companies explicitly automating portal workflows.

---

## 7. Customer Service & Support

> AI customer support tools need to ingest website content, help docs, and knowledge bases to power chatbots and AI assistants. This often starts as scraping but can escalate to authenticated session access for ticket systems and CRM portals.
> 

### Use Cases

- **Knowledge Base Ingestion from Websites** `[SCRAPE]` — Crawling customer-facing websites, help centers, FAQ pages, and documentation sites to populate AI assistant knowledge bases. The most common use case — converting HTML to LLM-ready markdown. *Ref: Answer HQ (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-answer-hq-powers-ai-customer-support-with-firecrawl); Botpress (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-botpress-enhances-knowledge-base-creation-with-firecrawl)*
- **Live Documentation Scraping for Phone/Voice Agents** `[SCRAPE]` — Keeping knowledge bases current so AI phone agents can answer customer inquiries from up-to-date documentation during live calls. *Ref: Retell AI (Firecrawl) — [source](https://www.firecrawl.dev/blog/retell-firecrawl-ai-phone-agents)*
- **Ticket System & CRM Automation** `[AGENT]` — AI agents logging into customer support platforms (Zendesk, Intercom, Freshdesk) and CRM systems to update tickets, pull customer context, and execute resolution workflows when APIs are insufficient.
- **Customer Portal Automation** `[AGENT]` — Performing actions on behalf of customers in self-service portals — updating account info, processing returns, checking order status — when backend APIs aren’t available.

### Target Companies

- giga.ai - https://giga.ai/browser-agent

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Retell AI | Firecrawl | AI phone agents using scraped docs for knowledge bases. Maintains customer docs/help center links as config for scrape jobs. Reuses templates by vertical. | [firecrawl.dev/blog/retell-firecrawl-ai-phone-agents](https://www.firecrawl.dev/blog/retell-firecrawl-ai-phone-agents) |
| Answer HQ | Firecrawl | AI customer support assistant. Website import runs entirely on Firecrawl. Previously tried Jina, custom crawlers, Playwright — all “exceptionally brittle.” | [firecrawl.dev/blog/how-answer-hq-powers-ai-customer-support-with-firecrawl](https://www.firecrawl.dev/blog/how-answer-hq-powers-ai-customer-support-with-firecrawl) |
| Botpress | Firecrawl | Chatbot platform using scraping for knowledge base creation. Most-valued feature: built-in HTML-to-Markdown conversion. | [firecrawl.dev/blog/how-botpress-enhances-knowledge-base-creation-with-firecrawl](https://www.firecrawl.dev/blog/how-botpress-enhances-knowledge-base-creation-with-firecrawl) |

### Notes

- This vertical is heavily `[SCRAPE]`tier. Most use cases are knowledge base ingestion — Firecrawl’s sweet spot. Steel’s differentiation here is limited unless the customer escalates to `[AGENT]`tier (ticket automation, portal actions).
- Worth tracking as a land-and-expand opportunity: companies that start with scraping for KB ingestion may later need full browser automation for agent-driven support workflows.
- Gigas (LinkedIn post reference) represents the CS agent use case that requires full browser control — agents that actually perform actions on behalf of customers.

---

## 8. Developer Tools & QA

> Developer tools companies use browser infrastructure for crawling documentation, monitoring web technology adoption at scale, testing web applications, and powering AI coding assistants with fresh web data.
> 

### Use Cases

- **Technology Adoption Intelligence** `[SESSION]` / `[AGENT]` — Crawling millions of websites simultaneously to detect technology stacks, framework adoption, and infrastructure patterns. Requires stealth capabilities to bypass CDN-level bot detection. *Ref: Vercel (Browserbase) built “Prism” intelligence system — [source](https://www.browserbase.com/blog/case-study-vercel)*
- **API Documentation Scraping for AI Assistants** `[SCRAPE]` — Fetching the latest API docs, library documentation, and technical references to keep AI coding assistants current. On-demand scraping triggered by the agent whenever needed. *Ref: Replit (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-replit-uses-firecrawl-to-power-ai-agents)*
- **Live Documentation Lookup for Code Review** `[RESEARCH]` — Verifying technical claims in code reviews against current third-party library documentation. Uses domain filtering to restrict searches to authoritative sources. *Ref: Macroscope (Parallel) achieved 55% reduction in review comments related to third-party libraries — [source](https://parallel.ai/blog/case-study-macroscope)*
- **Automated Web Application Testing & QA** `[AGENT]` — Running end-to-end tests against web applications in real browser environments. Visual regression testing, cross-browser compatibility, and automated UI testing at scale.
- **Website Performance & Rendering Analysis** `[SESSION]` — Loading websites in real browser environments to analyze rendering performance, JavaScript execution, Core Web Vitals, and user experience metrics.
- **CI/CD Pipeline Browser Testing** `[SESSION]` — Providing on-demand browser instances for automated test suites in CI/CD pipelines without requiring teams to maintain their own browser infrastructure.
- **API-less Third-Party Platform Integration** `[AGENT]` — Building reliable data pipelines from web sources that lack APIs by navigating their interfaces as a user would. Replaces weeks of brittle custom integration work. 30M+ workflows/month at scale. *Ref: TinyFish Technology — [source](https://www.tinyfish.ai/enterprise/technology)*
- Real-time front-end testing feedback loop for browser agents - They need a way to see their work!!

### Target Companies

*No Steel customers identified in this vertical yet. Dream targets to be researched and added.*

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Vercel | Browserbase | “Prism” system crawling millions of sites for tech adoption intelligence. Churn prediction, ship velocity index, revenue intelligence. Previously tried Puppeteer in-house — “legacy libraries are brittle.” | [browserbase.com/blog/case-study-vercel](https://www.browserbase.com/blog/case-study-vercel) |
| Replit | Firecrawl | AI coding assistant scraping latest API docs on-demand. Only 1 technical issue (500 error) in 4 months. Raw HTML insufficient — needs structured, usable information. | [firecrawl.dev/blog/how-replit-uses-firecrawl-to-power-ai-agents](https://www.firecrawl.dev/blog/how-replit-uses-firecrawl-to-power-ai-agents) |
| Macroscope | Parallel | AI code understanding engine using deep research to verify technical claims against live documentation during code reviews. 55% reduction in third-party library review comments. | [parallel.ai/blog/case-study-macroscope](https://parallel.ai/blog/case-study-macroscope) |

### Notes

- The Vercel case study is a standout: a major developer platform company using browser infra for market intelligence (not just “dev tools”). This suggests that many dev tools companies have internal intelligence use cases beyond their core product.
- QA/testing is a well-established category but is increasingly being disrupted by AI agents that can test dynamically rather than following scripted test plans.
- The `[SCRAPE]` use cases here (doc scraping) are Firecrawl/Parallel territory. Steel’s edge is in `[SESSION]`/`[AGENT]` use cases like large-scale crawling and QA automation.

---

## 9. E-Commerce & Marketplace

> E-commerce involves interacting with merchant websites for checkout, price monitoring, product data extraction, and optimization. Full browser agent capabilities are often required because checkout flows are interactive, anti-bot protected, and involve payment/auth steps.
> 

### Use Cases

- **Agentic Commerce / Autonomous Checkout** `[AGENT]` — AI agents that autonomously handle end-to-end checkout processes on any merchant website. Requires full browser control, human-like interaction, and precise proxy targeting for fraud detection avoidance. *Ref: Rye (Kernel) — “Stripe for agentic commerce” with ~2x better latency, $240K/year in engineering savings — [source](https://www.kernel.sh/blog/rye)*
- **Authenticated Competitive Pricing Intelligence** `[AGENT]` — Simulating real customer checkout flows on competitor platforms to capture receipt-level pricing including fees, taxes, and discounts — not just surface-level prices. Requires authenticated sessions across international markets at scale. *Ref: DoorDash (TinyFish) — 3x data volume increase across 20+ countries — [source](https://www.tinyfish.ai/customers/doordash)*
- **Price Monitoring & Competitive Intelligence** `[SCRAPE]` / `[SESSION]` — Crawling competitor product pages, pricing, availability, and reviews across marketplaces and DTC sites. Sessions needed for sites with anti-bot protection.
- **Product Data Extraction & Catalog Building** `[SCRAPE]` / `[SESSION]` — Extracting structured product data (titles, descriptions, images, specs, pricing) from marketplace listings and merchant sites for catalog aggregation.
- **Digital Shelf Monitoring & Optimization** `[SCRAPE]` / `[SESSION]` — Tracking product placement, descriptions, images, and availability across retailer websites to ensure brand presence and optimize positioning. At scale: 29.4M+ products tracked. *Ref: TinyFish Retail — [source](https://www.tinyfish.ai/enterprise/retail-and-consumer-goods)*
- **Checkout Experience Auditing** `[AGENT]` — Auditing checkout flows for upsells, promotions, friction points, and conversion optimization across e-commerce sites. Requires navigating full purchase journeys. *Ref: TinyFish Retail — [source](https://www.tinyfish.ai/enterprise/retail-and-consumer-goods)*
- **Website Optimization & A/B Testing** `[AGENT]` — AI-powered website optimization that extracts styling/structural elements, generates variations, and runs experiments. *Ref: Coframe (Browserbase) — 1000x improvement in time saved — [source](https://www.browserbase.com/blog/case-study-coframe)*
- **Affiliate Page Generation** `[SCRAPE]` — Scraping company websites to auto-generate affiliate landing pages. *Ref: Dub (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-dub-builds-ai-affiliate-pages-with-firecrawl)*
- **Marketplace Account Management** `[AGENT]` — Automating seller operations across Amazon, Shopify, and other marketplace dashboards — inventory updates, listing optimization, review management, advertising adjustments.

### Target Companies

- Octogen - Rye competitor

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Rye | Kernel | Universal Checkout API for agentic commerce. Previously self-hosted Mac minis in colo. ~2x better latency. $240K/year savings. ZIP-level proxy targeting for fraud detection. | [kernel.sh/blog/rye](https://www.kernel.sh/blog/rye) |
| Coframe | Browserbase | AI website optimization extracting styling/structural elements to train generative AI models. 1000x time savings. Parallel processing at scale. | [browserbase.com/blog/case-study-coframe](https://www.browserbase.com/blog/case-study-coframe) |
| Dub | Firecrawl | AI affiliate page builder that scrapes company websites and transforms them into landing pages using Claude Sonnet. | [firecrawl.dev/blog/how-dub-builds-ai-affiliate-pages-with-firecrawl](https://www.firecrawl.dev/blog/how-dub-builds-ai-affiliate-pages-with-firecrawl) |
| DoorDash | TinyFish | Simulated genuine customer checkout flows on competitor platforms across 20+ countries to capture authenticated, receipt-level pricing (fees, taxes, discounts). 3x increase in daily data collection volume. | [tinyfish.ai/customers/doordash](https://www.tinyfish.ai/customers/doordash) |
| TinyFish (vertical) | TinyFish | Retail vertical page describes dynamic competitive pricing intel (29.4M products tracked), digital shelf optimization, and checkout journey auditing. | [tinyfish.ai/enterprise/retail-and-consumer-goods](https://www.tinyfish.ai/enterprise/retail-and-consumer-goods) |

### Notes

- Rye’s use case is one of the strongest `[AGENT]`tier signals: autonomous checkout requires full browser control, low latency, and the agent must run on the same machine as the browser. Previously self-hosted Mac minis — extreme infrastructure need.
- E-commerce checkout automation has unique requirements: ZIP-level proxy targeting, fast cold starts, browser pause/resume for multi-step purchase flows.
- The lower-tier use cases (price monitoring, catalog scraping) are commoditized and Firecrawl territory. The high-value opportunity is autonomous checkout and marketplace automation.

---

## 10. Knowledge Base & Content Intelligence

> A massive horizontal use case: companies across many verticals need to ingest web content into knowledge bases, RAG pipelines, and AI agent context windows. This typically starts as scraping but can require sessions for authenticated or JS-heavy content.
> 

### Use Cases

- **Website-to-Knowledge-Base Ingestion** `[SCRAPE]` — Crawling entire websites and converting HTML to LLM-ready markdown for vector indexing pipelines. The most common use case in this category. *Ref: Credal (Firecrawl) processes 6M+ URLs/month — [source](https://www.firecrawl.dev/blog/credal-firecrawl-ai-agents); Stack AI (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-stack-ai-uses-firecrawl-to-power-ai-agents)*
- **Chatbot Knowledge Source Population** `[SCRAPE]` — Connecting chatbots to custom knowledge sources by scraping customers’ public websites and help centers. *Ref: Zapier (Firecrawl) — [source](https://www.firecrawl.dev/blog/how-zapier-uses-firecrawl-to-power-chatbots)*
- **Live Web Data Enrichment for Workflows** `[RESEARCH]` — Pulling live web data into no-code workflow automations for lead enrichment, competitive monitoring, and research tasks. *Ref: Lindy (Parallel) built “Chat with Web” and “Web enrichment” nodes — [source](https://parallel.ai/blog/case-study-lindy)*
- **Enterprise Knowledge Base from Internal + External Sources** `[SCRAPE]` / `[SESSION]` — Combining web crawling with internal source ingestion (Confluence, Google Drive) for comprehensive enterprise knowledge bases. Sessions needed for authenticated internal wikis or intranets. *Ref: Credal (Firecrawl) — [source](https://www.firecrawl.dev/blog/credal-firecrawl-ai-agents)*
- **Content Extraction for AI Training Data** `[SCRAPE]` — Large-scale web content extraction for training datasets, fine-tuning data, and model evaluation benchmarks.

### Target Companies

*No Steel customers identified in this vertical. This is primarily Firecrawl/Parallel territory at the `[SCRAPE]` tier, but represents a massive top-of-funnel opportunity.*

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Credal | Firecrawl | Enterprise AI platform processing 6M+ URLs/month. Dual use: ephemeral web search + durable website ingestion into knowledge bases alongside internal sources. | [firecrawl.dev/blog/credal-firecrawl-ai-agents](https://www.firecrawl.dev/blog/credal-firecrawl-ai-agents) |
| Zapier | Firecrawl | Chatbots product connecting to custom knowledge sources from public websites and help centers. | [firecrawl.dev/blog/how-zapier-uses-firecrawl-to-power-chatbots](https://www.firecrawl.dev/blog/how-zapier-uses-firecrawl-to-power-chatbots) |
| Stack AI | Firecrawl | AI platform ingesting website content as knowledge base. Integration completed in under 15 minutes. | [firecrawl.dev/blog/how-stack-ai-uses-firecrawl-to-power-ai-agents](https://www.firecrawl.dev/blog/how-stack-ai-uses-firecrawl-to-power-ai-agents) |
| Lindy | Parallel | No-code AI automation platform using tiered web research processors for live data enrichment in workflows. | [parallel.ai/blog/case-study-lindy](https://parallel.ai/blog/case-study-lindy) |
| Convergence | Browserbase | Consumer web agent platform (acquired by Salesforce). 200K users, 8-9K DAUs. Live session capabilities for human-in-the-loop. | [browserbase.com/blog/case-study-convergence](https://www.browserbase.com/blog/case-study-convergence) |

### Notes

- This is the highest-density cluster in Firecrawl’s customer base. The use case is heavily `[SCRAPE]`tier, which is Firecrawl’s sweet spot and lower ACV for Steel.
- However, this is a massive **land-and-expand** opportunity: companies that start with scraping for KB ingestion often graduate to `[SESSION]` or `[AGENT]` as their AI products mature and need to interact with authenticated or dynamic content.
- Convergence’s acquisition by Salesforce validates that large enterprises see browser automation as strategically important.
- The key differentiator for Steel here would be when customers need more than just scraping — JS-rendered content, authenticated sources, or dynamic navigation that a simple scrape API can’t handle.

---

## 11. Security & Compliance

> Security and compliance tools need to monitor web surfaces for threats, verify security postures, and automate compliance checks across fragmented regulatory portals.
> 

### Use Cases

- **Threat Intelligence & Dark Web Monitoring** `[SESSION]` — Monitoring forums, paste sites, and web surfaces for leaked credentials, threat actor activity, and brand mentions. Requires session management and stealth.
- **Attack Surface Monitoring** `[SCRAPE]` / `[SESSION]` — Continuously scanning an organization’s external web presence for exposed assets, misconfigurations, and vulnerabilities.
- **Compliance Portal Automation** `[AGENT]` — Navigating regulatory compliance portals (SOC2, GDPR, industry-specific) to submit evidence, download audit reports, and track compliance status.
- **Phishing Site Detection & Takedown** `[SESSION]` — Automated detection and evidence collection of phishing sites impersonating a brand, including screenshot capture and content verification.
- **Third-Party Risk Assessment** `[RESEARCH]` — Researching vendor security postures across multiple web sources (security ratings, breach databases, compliance certifications, news).

### Target Companies

*No Steel customers or specific dream targets identified yet. To be researched.*

### Notes

- This vertical is in the existing spreadsheet but has no specific competitor intel or customer data yet. It’s marked as emerging/P3 priority.
- The compliance portal automation use case (`[AGENT]` tier) is the highest-value opportunity here.
- Security companies tend to be sophisticated buyers of infrastructure — they understand browser automation deeply and have strong opinions about reliability and stealth.

---

## 12. Workflow Automation & RPA

> The next generation of RPA moves beyond brittle recorded macros to AI-powered browser agents that can adapt to UI changes, handle exceptions, and operate across any web application. This is a cross-cutting vertical — the “automation” layer that touches every industry.
> 

### Use Cases

- **Cross-Application Web Workflow Automation** `[AGENT]` — AI agents orchestrating multi-step workflows across multiple web applications that lack API integrations. The classic “RPA” use case, but with AI adaptability instead of brittle selectors. *Ref: Convergence (Browserbase) built a consumer web agent platform, acquired by Salesforce — [source](https://www.browserbase.com/blog/case-study-convergence)*
- **Legacy System Bridge** `[AGENT]` — Connecting modern systems to legacy web applications that only have browser interfaces. Common in enterprises with old ERP, HR, or procurement systems.
- **Scheduled Report Generation & Distribution** `[SESSION]` — Logging into reporting dashboards, generating reports with specific parameters, downloading/exporting, and distributing to stakeholders.
- **Data Migration Between Web Platforms** `[AGENT]` — Moving data between web applications during platform transitions when no export/import API exists.
- **Human-in-the-Loop Assisted Automation** `[AGENT]` — AI agents that handle routine steps but escalate to humans for ambiguous decisions, with live browser session handoff. *Ref: Convergence (Browserbase) used live session capabilities — [source](https://www.browserbase.com/blog/case-study-convergence)*

### Target Companies

*No Steel customers identified in this vertical yet. This is a horizontal category — targets are typically companies building “AI agent” or “AI automation” platforms.*

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Convergence | Browserbase | Consumer web agent platform automating daily tasks. 200K total users, 8-9K DAUs. Live session for human-in-the-loop. Avoided hiring 3-4 engineers for custom infra. Acquired by Salesforce. | [browserbase.com/blog/case-study-convergence](https://www.browserbase.com/blog/case-study-convergence) |

### Notes

- Convergence’s acquisition by Salesforce is the biggest validation signal for this vertical. Enterprise interest in AI-powered browser automation is real.
- “RPA 2.0” is the right framing — the market understands RPA ($billions) but the old approach (UiPath, Automation Anywhere) is brittle. AI-powered browser agents are the replacement wave.
- This vertical overlaps heavily with others (Healthcare RPA = Felicity, Logistics RPA = HappyRobot, etc.). The standalone section is for companies building horizontal automation platforms.

---

## 13. AI Training & RL Environments

> AI model training increasingly requires real browser environments — for reinforcement learning agents that learn to navigate the web, for generating training data from web interactions, and for evaluating model performance on web tasks.
> 

### Use Cases

- **Web Agent Training Environments** `[AGENT]` — Providing sandboxed browser environments for training RL agents to navigate websites, fill forms, and complete web-based tasks. Requires fast session spin-up and reset.
- **Training Data Collection from Web** `[SCRAPE]` / `[SESSION]` — Large-scale collection of web content, screenshots, and interaction traces for training multimodal AI models.
- **Model Evaluation on Web Tasks** `[AGENT]` — Running standardized web-based benchmarks (WebArena, MiniWoB, etc.) to evaluate AI agent performance in real browser environments.
- **Synthetic Web Interaction Generation** `[AGENT]` — Generating realistic web interaction traces (clicks, scrolls, form fills) for training data augmentation.

### Target Companies

*No Steel customers or specific targets identified yet. This vertical primarily serves AI research labs and companies building web-native AI agents.*

### Notes

- This is a niche but growing vertical as more AI companies build web agents that need to train in real browser environments.
- The key differentiator for Steel here is fast cold starts and the ability to spin up/tear down sessions rapidly for training loops.
- Pairs well with the “Browser Agent Companies” ecosystem (Browser-use, etc.) — these companies need training infra.

---

## 14. Non-Profit & Government

> Non-profits and government-adjacent organizations often need to interact with fragmented government portals, public databases, and regulatory systems that are exclusively web-based with no API access.
> 

### Use Cases

- **Government Benefit Portal Automation** `[AGENT]` — Automating access to government benefit systems (SNAP/EBT, Medicaid, unemployment) to extract data, verify eligibility, and manage enrollments on behalf of beneficiaries. *Ref: Benny (Browserbase) serves 42M SNAP recipients — [source](https://www.browserbase.com/blog/case-study-benny-2024)*
- **Resource & Service Mapping** `[SCRAPE]` / `[SESSION]` — Comprehensive web research to map available programs, services, and resources across communities. Extracting structured data from thousands of organizational websites. *Ref: Engage Together (Firecrawl) maps anti-trafficking resources — [source](https://www.firecrawl.dev/blog/how-engage-together-uses-firecrawl-to-map-anti-trafficking-resources)*
- **Grant & Funding Portal Navigation** `[AGENT]` — Navigating government grant portals (grants.gov, state-specific systems) to search for opportunities, submit applications, and track status.
- **Public Records Research** `[SESSION]` / `[RESEARCH]` — Systematically accessing public record databases, FOIA portals, and government data repositories for research and advocacy purposes.

### Target Companies

*No Steel customers identified. This is an emerging vertical.*

### Competitive Intelligence

| Company | Competitor | What They Built | Source |
| --- | --- | --- | --- |
| Benny | Browserbase | Platform serving 42M SNAP recipients. Automates access to government EBT portals with CAPTCHA solving, proxies, and session management. ~40% improvement in link success rate. | [browserbase.com/blog/case-study-benny-2024](https://www.browserbase.com/blog/case-study-benny-2024) |
| Engage Together | Firecrawl | Non-profit mapping anti-trafficking programs across communities. Extracts websites, addresses, contacts, program details from thousands of sites. Replaced “a dozen interns per region.” | [firecrawl.dev/blog/how-engage-together-uses-firecrawl-to-map-anti-trafficking-resources](https://www.firecrawl.dev/blog/how-engage-together-uses-firecrawl-to-map-anti-trafficking-resources) |

### Notes

- Benny straddles this vertical and Financial Services. Listed here because the government benefit portal interaction is the core browser automation use case.
- Government portals are notoriously difficult to automate — CAPTCHAs, session timeouts, brittle UIs. Strong need for `[AGENT]`tier capabilities.
- Non-profit organizations may have lower budgets but can be compelling case studies and mission-driven references.

---

## 15. Miscellaneous & Emerging

> Use cases and signals that don’t yet fit a defined vertical. When 3+ companies cluster around a theme, promote it to its own section.
> 

### Unclassified Use Cases

- **Browser Agent Frameworks** — Companies like Browser-use building open-source browser agent frameworks need reliable browser infrastructure underneath. These are both potential customers and ecosystem partners.
- **Scraping/Search Infrastructure Companies** — Companies like Firecrawl, Exa, Parallel, etc. that are themselves building scraping or search products may use Steel as underlying browser infrastructure. Competitive dynamics are complex here.
- **AI-Powered Website Builders** — Using browser automation to analyze existing sites, extract design patterns, and generate new websites or components. *Ref: Coframe (Browserbase) trains generative AI models from extracted website elements — [source](https://www.browserbase.com/blog/case-study-coframe)*

### Unclassified Signals

| Date Added | Company/Signal | What It Is | Potential Vertical | Source |
| --- | --- | --- | --- | --- |
| 2026-02-14 | Gigas (LinkedIn post) | Browser agent for customer service — performs actions in CRM/portals on behalf of agents | Customer Service / RPA | [LinkedIn post](https://www.linkedin.com/posts/varunvummadi_introducing-gigas-browser-agent-giga-can-activity-7420131379381854208-nGRI) |

### Verticals Under Consideration

- **Travel & Hospitality** — Strong signals from TinyFish. Use cases include:
    - **Competitor Rate Monitoring (incl. Member-Only Pricing)** `[SESSION]` / `[AGENT]` — Monitoring competitor pricing including loyalty program and member-only rates that sit behind logins. Traditional scraping can’t access authenticated pricing tiers. *Ref: TinyFish Travel — [source](https://www.tinyfish.ai/enterprise/travel-and-hospitality)*
    - **Property Availability Extraction** `[SCRAPE]` / `[SESSION]` — Extracting real-time availability and pricing from independent property websites to feed distribution channels. 40K+ properties connected at scale. *Ref: Google (TinyFish) — [source](https://www.tinyfish.ai/customers/google)*
    - **OTA Reputation Monitoring** `[SCRAPE]` — Tracking guest reviews, ratings, and sentiment across OTAs and review platforms. *Ref: TinyFish Travel — [source](https://www.tinyfish.ai/enterprise/travel-and-hospitality)*
    - *Competitive intel: Google used TinyFish to bring 40K+ Japanese local properties into search results by extracting structured data from hotel websites.*
    - Consider promoting to full vertical if more signals emerge.
- **HR & Recruiting** — Concrete signal from TinyFish. Use cases include:
    - **Automated Job Application Submission** `[AGENT]` — Navigating hundreds of employer websites with varied form structures to submit applications at scale. Agents must adapt to changing layouts without re-engineering. *Ref: Jobright.ai (TinyFish) — 30x YoY growth, 1M+ professionals, 2x interview rate — [source](https://www.tinyfish.ai/customers/jobright)*
    - **Job Board & Career Page Scraping** `[SCRAPE]` / `[SESSION]` — Extracting job listings, requirements, and company info from career pages and job boards for aggregation platforms.
    - **Background Check Portal Access** `[AGENT]` — Navigating government and private background check portals for employment verification.
    - Overlaps with Sales (LinkedIn scraping) and RPA. Consider promoting if more signals emerge.
- **Sports & Entertainment** — Early signal from TinyFish. Use cases include:
    - **Talent Scouting Intelligence** `[SCRAPE]` / `[SESSION]` — Monitoring FA websites, local news, fan forums, and social media to identify emerging talent before competitors.
    - **Competitive Performance Analysis** `[SCRAPE]` — Collecting match statistics, player data, and performance metrics from various web sources.
    - **Fan Engagement & Merchandising Monitoring** `[SCRAPE]` — Tracking ticket pricing, merchandise availability, and sponsorship activity across platforms.
    - *Ref: TinyFish Sports — [source](https://www.tinyfish.ai/enterprise/sports)*
- **Fitness & Wellness / Multi-Venue Operations** — Signal from ClassPass (TinyFish): automated operational management across 835 fitness venues daily, 98.6% time reduction. Browser automation for coordinating across partner venue portals/dashboards at scale. *Ref: ClassPass (TinyFish) — [source](https://www.tinyfish.ai/customers/classpass)*
- **Real Estate & Property Tech** — Property data scraping, MLS portal automation, title search automation. No current signals but likely exists.
- **Education & EdTech** — LMS automation, student information system portal access, academic database research. No current signals.

---

*End of document. New companies, use cases, and verticals should be added as they surface through research, customer conversations, and market signals.*