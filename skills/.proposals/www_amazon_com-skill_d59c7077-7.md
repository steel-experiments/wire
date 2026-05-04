---
id: skill_d59c7077-7697-485e-9781-7be53b2df0c8
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_371733db-8452-437e-865a-23c4c617a026
tags:
  - auto-promoted
  - www.amazon.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "www.amazon.com"
---

# Skill Proposal: www.amazon.com

Auto-generated from run `run_371733db-8452-437e-865a-23c4c617a026` with confidence 0.9.

## Facts

- Amazon Best Sellers category pages expose product cards via selectors like [id^="gridItemRoot"] or .zg-grid-general-faceout.
- On Amazon product detail pages, the main title is usually available at #productTitle.
- A review-page URL pattern is /product-reviews/{ASIN}, but navigating there may redirect to Amazon Sign-In.
- Best Sellers top-card extraction can use the first card's product link containing /dp/ to reach the product detail page.

## Selectors

- `[id^="gridItemRoot"]`
- `.zg-grid-general-faceout`
- `a[href*="/dp/"]`
- `a.a-link-normal`
- `._cDEzb_p13n-sc-css-line-clamp-3_g3dy1`
- `.p13n-sc-truncate`
- `#productTitle`
- `.a-price .a-offscreen`
- `a[data-hook="see-all-reviews-link-foot"]`
- `a[href*="product-reviews"]`
- `[data-hook="review"]`
- `[data-hook="review-star-rating"],[data-hook="cmps-review-star-rating"]`

## Routes

- `https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics/`
- `/dp/{ASIN}`
- `/product-reviews/{ASIN}`

## Known Traps

- Direct navigation from a product page to /product-reviews/{ASIN} can trigger a redirect to /ap/signin (auth wall).
- Using a generic price selector .a-price .a-offscreen on Amazon PDPs can return an unrelated price; in this trace it returned $180.00 for a product listed as $11.99 on the Best Sellers page.
- #gridItemRoot may not be unique or present exactly once; use [id^="gridItemRoot"] or .zg-grid-general-faceout as fallbacks.
