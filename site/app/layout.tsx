import type { Metadata } from "next";
import { DM_Sans, IBM_Plex_Mono, Libre_Baskerville } from "next/font/google";
import "./globals.css";

const display = Libre_Baskerville({ variable: "--font-display", subsets: ["latin"], weight: ["400", "700"], style: ["normal", "italic"], display: "swap" });
const body = DM_Sans({ variable: "--font-body", subsets: ["latin"], display: "swap" });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://jobappagent.com"),
  manifest: "/manifest.webmanifest",
  title: { default: "JobAppAgent", template: "%s · JobAppAgent" },
  description: "A calmer way to job hunt. JobAppAgent keeps disciplined, truthful applications moving inside boundaries you control.",
  openGraph: { title: "JobAppAgent — A calmer way to job hunt.", description: "A disciplined job-search agent that keeps the routine moving and real decisions with you.", type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "JobAppAgent, a calmer way to keep your job search moving" }] },
  twitter: { card: "summary_large_image", title: "JobAppAgent — A calmer way to job hunt.", description: "A disciplined job-search agent that keeps the routine moving and real decisions with you.", images: ["/og.png"] },
  icons: {
    icon: [{ url: "/favicon.png", sizes: "64x64", type: "image/png" }],
    shortcut: "/favicon.png",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${display.variable} ${body.variable} ${mono.variable}`}>{children}</body></html>;
}
