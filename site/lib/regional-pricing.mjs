const globalOffer = Object.freeze({
  region: "global",
  amount: 49,
  currency: "USD",
  displayPrice: "$49",
  priceNote: "global pre-launch price",
});

const indiaOffer = Object.freeze({
  region: "india",
  amount: 3999,
  currency: "INR",
  displayPrice: "₹3,999",
  priceNote: "including GST in India",
});

export function resolveOfferPricing(countryCode) {
  const normalized = typeof countryCode === "string" && /^[a-z]{2}$/i.test(countryCode)
    ? countryCode.toUpperCase()
    : null;
  return normalized === "IN" ? indiaOffer : globalOffer;
}
