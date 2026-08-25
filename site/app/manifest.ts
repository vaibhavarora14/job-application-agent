import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JobAppAgent",
    short_name: "JobAppAgent",
    description: "A calmer job search with disciplined automation and clear boundaries.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2e9d8",
    theme_color: "#173f35",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
