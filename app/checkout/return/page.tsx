import type { Metadata } from "next";
import { PaymentReturnStatus } from "../../components/PaymentReturnStatus";

export const metadata: Metadata = { title: "Payment status", robots: { index: false, follow: false } };

export default function CheckoutReturnPage() {
  return <main className="payment-return page-width"><PaymentReturnStatus /></main>;
}
