import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://jobappagent.com"),
  title: { default: "Job Application Agent", template: "%s · Job Application Agent" },
  description: "Set the goal. Let a disciplined job-search agent discover, qualify, apply, pause, and learn continuously in the cloud.",
  openGraph: { title: "Set the goal. Keep the search moving.", description: "A disciplined job-search agent with verified facts and clear boundaries.", type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Set the goal. Keep the search moving." }] },
  twitter: { card: "summary_large_image", title: "Set the goal. Keep the search moving.", description: "A disciplined job-search agent with verified facts and clear boundaries.", images: ["/og.png"] },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${archivo.variable} ${plexMono.variable}`}>{children}</body></html>;
}
