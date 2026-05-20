---
id: skill_8e8cc58b-e7af-42f6-baab-6e8ff23a6e4c
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_71fa3d79-3be4-4bd2-a9f0-5edb348eb16e
tags:
  - auto-promoted
  - lumer-shop.eu
updatedAt: 2026-05-15
hostnamePatterns:
  - "lumer-shop.eu"
---

# Skill Proposal: lumer-shop.eu

Auto-generated from run `run_71fa3d79-3be4-4bd2-a9f0-5edb348eb16e` with confidence 0.86.

## Facts

- Homepage title is 'Lumer Shop – T-Shirts & Merchandise Shop'.
- The custom T-shirt flow goes through /napravi-majicu/ and the product page /shop/majica-s-tvojim-dizajnom/.
- Product page 'Majica s tvojim dizajnom' contains WooCommerce variation selects for color and size.
- Detected variation selectors: select[name="attribute_pa_boja"] for color and select[name="attribute_pa_velicina"] for size.
- A customization iframe is present on the product page with src containing 'zakeke.com/Customizer'.
- Text-based clicks on menu/card elements may match anchors whose textContent is polluted by nested img markup, so href-based targeting is more reliable.

## Selectors

- `select[name="attribute_pa_boja"]`
- `select[name="attribute_pa_velicina"]`
- `iframe[src*="zakeke.com/Customizer"]`
- `a[href*="/shop/majica-s-tvojim-dizajnom/"]`
- `a[href*="/napravi-majicu/"]`

## Routes

- `https://lumer-shop.eu/`
- `https://lumer-shop.eu/napravi-majicu/`
- `https://lumer-shop.eu/shop/majica-s-tvojim-dizajnom/`

## Wait Patterns

- `After navigation, confirm location.href is https://lumer-shop.eu/shop/majica-s-tvojim-dizajnom/ before querying variation selects.`
- `Expect embedded customizer content to load in an iframe from zakeke.com; wait for the iframe element if the task involves customization.`

## Known Traps

- Directly setting size/color select values and dispatching change events caused CDP Runtime.evaluate timeouts three times on the product page; avoid large synchronous evaluate blocks for variation changes.
- Do not rely on exact visible text matching for the 'Napravi Majicu' or product card links because returned textContent included img markup/lazyload artifacts and still clicked unexpected-looking elements.
- If a text click is ambiguous, prefer direct navigation to /shop/majica-s-tvojim-dizajnom/ or href-based anchor selection instead of scanning all a/button elements by text.
