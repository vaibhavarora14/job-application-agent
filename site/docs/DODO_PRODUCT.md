# Dodo founding product display (ops)

Checkout Sessions created by `/api/checkout` only send `product_id`, quantity, return/cancel URLs, metadata, and theme customization. **Product Name and Description are not overrideable in the Checkout Session `product_cart`** (Dodo `ProductItemReq` has no name/description fields). Buyers see whatever is stored on the Dodo product record.

## Required dashboard copy (Hosted founding — soft-activate)

Update the live founding product in the Dodo Payments dashboard:

| Field | Required value |
| --- | --- |
| **Product name** | `Job Application Agent — Founding Hosted Access` |
| **Product description** | `90 days of founding hosted access. Your window starts when we activate your seat and email access details — not on payment alone. Cloud access remains coming soon.` |

Do **not** use “Founding Cloud Access”, “founding cloud access”, or any wording that implies Cloud is what the buyer purchased while marketing still shows Cloud **COMING SOON**.

Canonical strings also live in code as `FOUNDING_DODO_PRODUCT_DISPLAY` in `lib/payment-core.mjs` (documentation + metadata only — they do not change the Dodo UI by themselves).

## After updating the dashboard

1. Create a **new** checkout session (existing reusable `founding_purchase` cookies may still open an older session that cached the previous title).
2. Confirm the Dodo checkout page title/description use **Hosted**, not Cloud.
3. Design can recheck post-pay success without a card charge at  
   `https://jobappagent.com/checkout/return?design=success`  
   (`design=success` is a UI fixture only; it never marks a purchase paid).

## Out of scope for this lane

- Automatic seat mint / webhook money-path ops
- Calling `products.update` from the checkout Worker on every session
- Claiming Cloud OPEN on the SKU
