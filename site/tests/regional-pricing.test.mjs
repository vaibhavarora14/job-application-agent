import assert from "node:assert/strict";
import test from "node:test";
import { resolveOfferPricing } from "../lib/regional-pricing.mjs";

test("shows the tax-inclusive India offer only to visitors resolved to India", () => {
  assert.deepEqual(resolveOfferPricing("IN"), {
    region: "india",
    amount: 3999,
    currency: "INR",
    displayPrice: "₹3,999",
    priceNote: "including GST in India",
  });
  assert.deepEqual(resolveOfferPricing("in"), resolveOfferPricing("IN"));
});

test("shows the global offer for every other or untrusted country value", () => {
  const globalOffer = {
    region: "global",
    amount: 49,
    currency: "USD",
    displayPrice: "$49",
    priceNote: "global pre-launch price",
  };
  assert.deepEqual(resolveOfferPricing("US"), globalOffer);
  assert.deepEqual(resolveOfferPricing(undefined), globalOffer);
  assert.deepEqual(resolveOfferPricing("IND"), globalOffer);
  assert.deepEqual(resolveOfferPricing("<script>"), globalOffer);
});
