---
id: skill_7df6d3fd-ec99-484c-914e-ed65686c7bb6
scope: domain
status: proposed
source: generated
confidence: 0.85
sourceRunIds:
  - run_142e1a6b-78ff-4263-a835-22aae553a3ff
tags:
  - auto-promoted
  - lumer-shop.eu
updatedAt: 2026-05-20
hostnamePatterns:
  - "lumer-shop.eu"
---

# Skill Proposal: lumer-shop.eu

Auto-generated from run `run_142e1a6b-78ff-4263-a835-22aae553a3ff` with confidence 0.85.

## Workflow

1. Step 1: Navigate directly to https://lumer-shop.eu/shop/majica-s-tvojim-dizajnom/.
2. Step 2: If a cookie banner is present, click the visible text "OK" once.
3. Step 3: Select size via select[name="attribute_pa_velicina"] by setting value to the variation slug (e.g. "xl") and dispatching a change event.
4. Step 4: Select color via select[name="attribute_pa_boja"] by matching option text/value against /crna|black/i; discovered black value is "black".
5. Step 5: Do not retry the cookie click after dismissal; first re-check that the variation selects still exist before interacting.

## Facts

- Product page route for custom T-shirt: /shop/majica-s-tvojim-dizajnom/.
- Variation attributes use WooCommerce-style selects named attribute_pa_velicina (size) and attribute_pa_boja (color).
- A working size value observed was "xl".
- A working black color option value observed was "black".
- Cookie consent can appear with a visible "OK" button, but only initially.

## Selectors

- `select[name="attribute_pa_velicina"]`
- `select[name="attribute_pa_boja"]`

## Routes

- `https://lumer-shop.eu/`
- `https://lumer-shop.eu/shop/majica-s-tvojim-dizajnom/`

## Wait Patterns

- `After landing on the product page, check for the cookie banner before interacting with variation selects.`
- `If a selector lookup fails after a previous success, re-query after page/UI stabilization instead of repeating unrelated clicks.`

## Known Traps

- Repeatedly calling clickVisibleText("OK") fails once the cookie banner has already been dismissed: error "no visible element with text 'OK'".
- Variation select lookup can fail intermittently even after a prior success; do not assume the selects are immediately available on every retry.
- Avoid retrying the exact same variation-selection script unchanged after consecutive failures; it produced repeated "Variation selects not found" / missing OK errors.
