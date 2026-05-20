---
id: skill_c4cdeb6a-f192-4a8e-9722-ef829fc365a2
scope: domain
status: proposed
source: generated
confidence: 0.94
sourceRunIds:
  - run_a603813a-dbdb-4713-b6e7-a11a49af4e2c
tags:
  - auto-promoted
  - lumer-shop.eu
updatedAt: 2026-05-15
hostnamePatterns:
  - "lumer-shop.eu"
---

# Skill Proposal: lumer-shop.eu

Auto-generated from run `run_a603813a-dbdb-4713-b6e7-a11a49af4e2c` with confidence 0.94.

## Facts

- Homepage has a cookie banner with an 'OK' accept button.
- The custom T-shirt flow is reachable from /napravi-majicu/ and the product 'Majica s tvojim dizajnom'.
- Product page route observed as /shop/majica-s-tvojim-dizajnom/.
- Variant selects were initially available on the product page; size option 'XL' maps to value 'xl' and black color maps to value 'black'.
- After activating customization, the page embeds the Zakeke editor in an iframe hosted at portal.zakeke.com/Customizer/index.html.
- Once the editor/iframe is active, the original WooCommerce variant selects are no longer present in the top-level DOM.

## Selectors

- `button,a matching exact text 'OK' for cookie consent`
- `select[name="attribute_pa_velicina"]`
- `select[name="attribute_pa_boja"]`
- `button, a, input[type="submit"] matching text /customize/i`

## Routes

- `https://lumer-shop.eu/`
- `https://lumer-shop.eu/napravi-majicu/`
- `https://lumer-shop.eu/shop/majica-s-tvojim-dizajnom/`

## Wait Patterns

- `After navigating to /napravi-majicu/, inspect product cards and follow the 'Majica s tvojim dizajnom' option.`
- `Set size/color before clicking CUSTOMIZE.`
- `After clicking CUSTOMIZE, wait for the embedded Zakeke iframe (portal.zakeke.com/Customizer/...) rather than expecting the same select elements to remain.`
- `If a long DOM query/change script hangs on the product page, break the interaction into smaller steps; one combined select-setting script timed out.`

## Known Traps

- Do not keep searching for size/color <select> elements after CUSTOMIZE/editor has opened; document.querySelectorAll('select') then returns none and repeated retries are wasted.
- Avoid assuming selects always exist at indexes [0] and [1]; after the editor loads this caused undefined/options errors.
- Do not rely only on top-level labels or form text to rediscover variant selects after customization; they disappear from the main DOM.
- A large all-in-one Runtime.evaluate for finding labeled selects and setting them timed out after 12s; prefer shorter targeted scripts.
