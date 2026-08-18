import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://jobapplicationagent.ai"),
  title: { default: "Job Application Agent", template: "%s · Job Application Agent" },
  description: "Set the goal. Let the open job-search agent discover, qualify, apply, pause, and learn — locally today and continuously in the cloud.",
  openGraph: { title: "Set the goal. Let the agent run the search.", description: "The open-source job application agent, extended to the cloud.", type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Set the goal. Let the agent run the search." }] },
  twitter: { card: "summary_large_image", title: "Set the goal. Let the agent run the search.", description: "The open-source job application agent, extended to the cloud.", images: ["/og.png"] },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${archivo.variable} ${plexMono.variable}`}>{children}</body></html>;
}
