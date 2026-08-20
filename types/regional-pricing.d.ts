declare module "*/regional-pricing.mjs" {
  export type OfferPricing = {
    region: "india" | "global";
    amount: 3999 | 49;
    currency: "INR" | "USD";
    displayPrice: "₹3,999" | "$49";
    priceNote: "including GST in India" | "global pre-launch price";
  };
  export function resolveOfferPricing(countryCode?: string | null): OfferPricing;
}
