import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JobAppAgent",
    short_name: "JobAppAgent",
    description: "Autonomous job search with verified facts and clear boundaries.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f9fc",
    theme_color: "#12213b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
