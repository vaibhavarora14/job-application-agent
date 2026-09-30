import { Inter, Instrument_Serif } from "next/font/google";
import "./buyer-flow.css";

const sans = Inter({ variable: "--font-buyer-sans", subsets: ["latin"], display: "swap" });
const serif = Instrument_Serif({ variable: "--font-buyer-serif", subsets: ["latin"], weight: "400", display: "swap" });

export default function AttentionLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${sans.variable} ${serif.variable}`}>{children}</div>;
}
