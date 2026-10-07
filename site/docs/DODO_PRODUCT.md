# Dodo founding product display (ops)

Checkout Sessions created by `/api/checkout` only send `product_id`, quantity, return/cancel URLs, metadata, and theme customization. **Product Name and Description are not overrideable in the Checkout Session `product_cart`** (Dodo `ProductItemReq` has no name/description fields). Buyers see whatever is stored on the Dodo product record.

## Required dashboard copy (Hosted founding — reservation / coming soon)

Update the live founding product in the Dodo Payments dashboard (ops only — site code does not call Dodo product APIs):

| Field | Required value |
| --- | --- |
| **Product name** | `Job Application Agent — Founding Hosted Access` |
| **Product description** | `Founding reservation for hosted access when it launches — not instant access. Hosted remains coming soon; no launch date promised. Listed at $49 USD; when billing to India, checkout shows the intentional India founding price plus GST.` |

Do **not** use “Founding Cloud Access”, “founding cloud access”, or any wording that implies Cloud is what the buyer purchased while marketing still shows Cloud **COMING SOON**.

Canonical strings also live in code as `FOUNDING_DODO_PRODUCT_DISPLAY` in `lib/payment-core.mjs` (documentation + metadata only — they do not change the Dodo UI by themselves).

## After updating the dashboard

1. Create a **new** checkout session (existing reusable `founding_purchase` cookies may still open an older session that cached the previous title).
2. Confirm the Dodo checkout page title/description use **Hosted**, not Cloud.
3. Design can recheck post-pay success without a card charge at  
   `https://jobappagent.com/checkout/return?design=success`  
   (`design=success` is a UI fixture only; it never marks a purchase paid).

## Related ops

- Money-path option A (paid → D1 succeeded + Support alert, manual seat activate):
  [`FOUNDING_ACTIVATION.md`](FOUNDING_ACTIVATION.md)

## Out of scope for product-display ops

- Automatic seat mint on webhook (paid ≠ activated)
- Calling `products.update` from the checkout Worker on every session
- Claiming Cloud OPEN on the SKU
