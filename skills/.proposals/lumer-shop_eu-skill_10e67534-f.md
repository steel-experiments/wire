---
id: skill_10e67534-fd55-4674-b428-9d09f7bb554e
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_c0c267dc-c4da-4143-a9a7-fa54866c593a
tags:
  - auto-promoted
  - lumer-shop.eu
updatedAt: 2026-05-15
hostnamePatterns:
  - "lumer-shop.eu"
---

# Skill Proposal: lumer-shop.eu

Auto-generated from run `run_c0c267dc-c4da-4143-a9a7-fa54866c593a` with confidence 0.92.

## Facts

- Product page for custom t-shirt is at /shop/majica-s-tvojim-dizajnom/.
- Selecting size via select[name="attribute_pa_velicina"] with value "xl" and color via select[name="attribute_pa_boja"] with value "black" prepares the black XL variant.
- After variant selection, the flow reaches an embedded Zakeke customizer iframe hosted on portal.zakeke.com/Customizer.

## Selectors

- `select[name="attribute_pa_velicina"]`
- `select[name="attribute_pa_boja"]`
- `iframe[src*="zakeke.com/Customizer"]`

## Routes

- `/`
- `/shop/majica-s-tvojim-dizajnom/`

## Wait Patterns

- `After setting variation select values, wait for the Zakeke customizer iframe to appear/load rather than expecting a full-page navigation.`

## Known Traps

- Do not rely on reading back select.value immediately after the page has transitioned into the customizer state; the original variant selects may no longer be present and can return null.
- Do not expect top-level file inputs on the product page once customization starts; the upload UI lives inside the embedded Zakeke iframe.
- A generic text click for "Customize"/cookie "OK" can report success, but the reliable signal is presence of iframe[src*="zakeke.com/Customizer"].
