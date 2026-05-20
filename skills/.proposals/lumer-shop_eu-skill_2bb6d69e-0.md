---
id: skill_2bb6d69e-0034-4800-9096-09393c40b40a
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_370add8f-957d-4e6a-a96b-a828392370fd
tags:
  - auto-promoted
  - lumer-shop.eu
updatedAt: 2026-05-15
hostnamePatterns:
  - "lumer-shop.eu"
---

# Skill Proposal: lumer-shop.eu

Auto-generated from run `run_370add8f-957d-4e6a-a96b-a828392370fd` with confidence 0.89.

## Facts

- Product customization for 'Majica s tvojim dizajnom' opens inside a Zakeke iframe with src containing 'portal.zakeke.com/Customizer'.
- Cookie consent may need dismissal via a control with exact text or aria-label 'OK'.
- After opening the customizer iframe, the WooCommerce variation selects may no longer be readable from the page DOM and can return null even if values were set earlier.
- A successful state for the objective was reaching the product page with the Zakeke customizer iframe present while the session stayed live.

## Selectors

- `button[aria-label="OK"]`
- `select[name="attribute_pa_velicina"]`
- `select[name="attribute_pa_boja"]`
- `iframe[src*="zakeke.com/Customizer"]`
- `input[type="file"]`

## Routes

- `/shop/majica-s-tvojim-dizajnom/`

## Wait Patterns

- `Wait for iframe[src*="zakeke.com/Customizer"] after clicking the customize action.`
- `Dismiss cookie consent before interacting with variation selects or customize controls if an 'OK' button is present.`

## Known Traps

- Do not expect input[type="file"] on the outer product page; customization is handled inside the Zakeke iframe.
- Do not verify selected size/color by reading select[name="attribute_pa_velicina"] or select[name="attribute_pa_boja"] after the customizer opens; these fields may become null/unavailable.
- A generic text search for a 'Customize' button can fail even when customization succeeded; iframe presence is a more reliable signal.
