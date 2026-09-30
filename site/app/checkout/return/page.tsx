import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PaymentReturnStatus } from "../../components/PaymentReturnStatus";
import { canonicalCheckoutReturnUrl, isCheckoutDesignSuccess } from "../../../lib/payment-core.mjs";

export const metadata: Metadata = { title: "Payment status", robots: { index: false, follow: false } };

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const canonicalUrl = canonicalCheckoutReturnUrl(params);
  if (canonicalUrl) redirect(canonicalUrl);
  const designSuccess = isCheckoutDesignSuccess(params);
  return <main className="payment-return page-width"><PaymentReturnStatus designSuccess={designSuccess} /></main>;
}
