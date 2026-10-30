import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import hostingConfig from "./.openai/hosting.json";
import {
  LOCATION_SHARD_COUNT,
  buildLocationShards,
  lookupModuleSource,
  shardModuleSource,
} from "./scripts/job-location-shards.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

/**
 * Bundle data/job-locations.json as `JSON.parse("…")` instead of a JS object literal.
 * Every cold isolate that renders /jobs or a job page evaluates this chunk (Workers
 * Free: 10 ms CPU budget). Measured locally (Node, cold): 13.5 ms as an object literal,
 * 10.2 ms as JSON.parse. Same value at runtime. Vite's `json.stringify` option is not
 * applied by this build, hence the plugin.
 */
function jsonParseLargeData(): Plugin {
  return {
    name: "jobappagent:json-parse-large-data",
    enforce: "pre",
    async load(id) {
      const file = id.split("?")[0];
      if (!file.endsWith("/data/job-locations.json")) return null;
      const text = JSON.stringify(JSON.parse(await readFile(file, "utf8")));
      return { code: `export default JSON.parse(${JSON.stringify(text)});`, moduleType: "js" };
    },
  };
}

/**
 * Replace lib/job-location-lookup.mjs with a sharded version in the Worker build.
 * A job page needs one location record, but importing data/job-locations.json
 * evaluates all ~1,600 records (~4.5 ms CPU on a cold isolate, of a 10 ms budget).
 * The records are split by jobId into LOCATION_SHARD_COUNT lazily imported chunks;
 * the page imports only its own. Same record per jobId as the Node module (tested).
 */
function jobLocationShards(): Plugin {
  const prefix = "virtual:jobappagent-location-shard/";
  const dataFile = fileURLToPath(new URL("./data/job-locations.json", import.meta.url));
  let shards: Promise<object[]> | null = null;
  const loadShards = () =>
    (shards ??= readFile(dataFile, "utf8").then((text) => buildLocationShards(JSON.parse(text))));
  return {
    name: "jobappagent:job-location-shards",
    enforce: "pre",
    resolveId(id) {
      return id.startsWith(prefix) ? `\0${id}` : null;
    },
    watchChange(id) {
      if (id === dataFile) shards = null;
    },
    async load(id) {
      if (id.startsWith(`\0${prefix}`)) {
        const index = Number(id.slice(prefix.length + 1));
        const all = await loadShards();
        return { code: shardModuleSource(all[index] ?? {}), moduleType: "js" };
      }
      if (id.split("?")[0].endsWith("/lib/job-location-lookup.mjs")) {
        this.addWatchFile(dataFile);
        const code = lookupModuleSource(LOCATION_SHARD_COUNT, (i) => `${prefix}${i}`, dataFile);
        return { code, moduleType: "js" };
      }
      return null;
    },
  };
}

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      jsonParseLargeData(),
      jobLocationShards(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
