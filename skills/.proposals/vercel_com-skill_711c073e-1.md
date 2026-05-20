---
id: skill_711c073e-164b-4ecf-9372-cc516c561979
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_68966815-6e1d-4204-9640-ad47bc97a96b
tags:
  - auto-promoted
  - vercel.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "vercel.com"
---

# Skill Proposal: vercel.com

Auto-generated from run `run_68966815-6e1d-4204-9640-ad47bc97a96b` with confidence 0.89.

## Workflow

1. Step 1: Navigate directly to the pricing pages: https://vercel.com/pricing, https://www.netlify.com/pricing/, and https://railway.com/pricing.
2. Step 2: Read document.body.innerText, split by newline, trim blanks, and parse plan sections by locating exact plan-name headings.
3. Step 3: For Vercel, slice from 'Hobby', 'Pro', or 'Enterprise' until the next plan heading.
4. Step 4: For Netlify, slice from 'Free'/'Starter', 'Personal', 'Pro', or 'Enterprise' until the next known heading, limiting the slice size to avoid page-wide spillover.
5. Step 5: For Railway, slice from 'Free' or other plan headings until the next known heading, also capping the block length.
6. Step 6: Compile the extracted blocks into the comparison output.

## Facts

- Direct pricing routes were accessible without login for all three providers.
- Pricing content for Vercel, Netlify, and Railway was extractable from visible page text via document.body.innerText rather than requiring interaction.
- Vercel pricing page title observed: 'Vercel Pricing: Hobby, Pro, and Enterprise plans'.
- Netlify pricing page title observed: 'Pricing and Plans | Netlify'.
- Railway pricing page title observed: 'Pricing | Railway'.
- Exact plan heading text is a reliable anchor for text parsing on these pricing pages.

## Selectors

- `document.body.innerText`

## Routes

- `https://vercel.com/pricing`
- `https://www.netlify.com/pricing/`
- `https://railway.com/pricing`

## Wait Patterns

- `Wait for the pricing page URL/title to load before reading document.body.innerText.`
- `If parsing by headings, ensure body text is populated before splitting into lines.`

## Known Traps

- Do not rely on complex DOM selectors when the pricing content is already available in document.body.innerText.
- Avoid unbounded slicing after a matched plan heading; stop at the next known plan heading or cap the number of lines to prevent mixing sections.
- Netlify plan names may differ from assumptions ('Free' vs 'Starter'); support alternate heading labels when locating sections.
