import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PaymentReturnStatus } from "../../components/PaymentReturnStatus";
import { canonicalCheckoutReturnUrl } from "../../../lib/payment-core.mjs";

export const metadata: Metadata = { title: "Payment status", robots: { index: false, follow: false } };

export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const canonicalUrl = canonicalCheckoutReturnUrl(await searchParams);
  if (canonicalUrl) redirect(canonicalUrl);
  return <main className="payment-return page-width"><PaymentReturnStatus /></main>;
}
