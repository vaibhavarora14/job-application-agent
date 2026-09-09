import { mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ALLOWLIST } from "./worker.mjs";

const DEFAULT_STATE_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "job-application-agent",
);

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "job-application-agent-cloud",
  "config.json",
);

const DEFAULT_KEYCHAIN_SERVICE = "com.vaibhavarora.job-application-agent";
const LEGACY_KEYCHAIN_SERVICE = "com.openai.codex.job-application-agent";

export function getStateDir() {
  return process.env.JOB_APPLICATION_AGENT_STATE_DIR ?? DEFAULT_STATE_DIR;
}

export function getConfigPath() {
  return (
    process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG ?? DEFAULT_CONFIG_PATH
  );
}

export function getKeychainService() {
  return (
    process.env.JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE ??
    DEFAULT_KEYCHAIN_SERVICE
  );
}

export function createFetch(fetchImpl = globalThis.fetch) {
  return fetchImpl;
}

export async function readConfig() {
  const configPath = getConfigPath();
  try {
    const text = await readFile(configPath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writeConfig(config) {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  return configPath;
}

export async function enableCommand(argv, stdinText = "") {
  let url;
  let token;

  const urlIdx = argv.indexOf("--url");
  const tokenIdx = argv.indexOf("--token");
  if (urlIdx !== -1 && tokenIdx !== -1) {
    url = argv[urlIdx + 1];
    token = argv[tokenIdx + 1];
  } else if (stdinText.trim()) {
    const parsed = JSON.parse(stdinText);
    url = parsed.url;
    token = parsed.token;
  } else {
    throw new Error("usage: enable --url URL --token TOKEN  OR  JSON on stdin");
  }

  if (!url || !token) {
    throw new Error("url and token are required");
  }

  const configPath = await writeConfig({ url: url.replace(/\/$/, ""), token });
  return { configPath, url: url.replace(/\/$/, "") };
}

export function readProfileFromKeychain() {
  const service = getKeychainService();
  for (const svc of [service, LEGACY_KEYCHAIN_SERVICE]) {
    try {
      const value = execFileSync(
        "security",
        ["find-generic-password", "-s", svc, "-a", "profile", "-w"],
        { encoding: "utf8" },
      ).trim();
      if (value) {
        return JSON.parse(value);
      }
    } catch {
      // try next service
    }
  }
  return null;
}

export function writeProfileToKeychain(profile) {
  const service = getKeychainService();
  const json = JSON.stringify(profile);
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-a",
      "profile",
      "-s",
      service,
      "-U",
      "-w",
      json,
    ],
    { encoding: "utf8" },
  );
}

export async function authFetch(config, path, options = {}, fetchImpl) {
  const fetchFn = createFetch(fetchImpl);
  const url = `${config.url}${path}`;
  const headers = {
    ...(options.headers ?? {}),
    authorization: `Bearer ${config.token}`,
  };
  return fetchFn(url, { ...options, headers });
}

export async function getManifest(config, fetchImpl) {
  const res = await authFetch(
    config,
    "/v1/manifest",
    { method: "GET" },
    fetchImpl,
  );
  if (!res.ok) {
    throw new Error(`manifest failed: ${res.status}`);
  }
  return res.json();
}

export async function statusCommand(fetchImpl) {
  const config = await readConfig();
  const stateDir = getStateDir();
  let localExists = false;
  try {
    await access(stateDir, constants.F_OK);
    localExists = true;
  } catch {
    localExists = false;
  }

  const result = {
    url: config?.url ?? null,
    stateDir,
    localDirExists: localExists,
    configured: Boolean(config?.url && config?.token),
  };

  if (config?.url && config?.token) {
    try {
      const fetchFn = createFetch(fetchImpl);
      const head = await fetchFn(`${config.url}/healthz`, { method: "GET" });
      result.healthz = head.ok;
    } catch (err) {
      result.healthz = false;
      result.healthError = err.message;
    }
    try {
      result.manifestCount = (await getManifest(config, fetchImpl)).length;
    } catch (err) {
      result.manifestError = err.message;
    }
  }

  return result;
}

export async function pushCommand(fetchImpl) {
  const config = await readConfig();
  if (!config?.url || !config?.token) {
    throw new Error("not configured; run enable first");
  }

  const stateDir = getStateDir();
  const results = [];

  for (const name of ALLOWLIST) {
    const localPath = join(stateDir, name);
    try {
      await access(localPath, constants.F_OK);
    } catch {
      continue;
    }
    const body = await readFile(localPath);
    const manifest = await getManifest(config, fetchImpl);
    const remote = manifest.find((entry) => entry.name === name);
    const headers = {};
    if (remote?.etag) {
      headers["if-match"] = remote.etag;
    }
    const res = await authFetch(
      config,
      `/v1/files/${encodeURIComponent(name)}`,
      { method: "PUT", body, headers },
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`push ${name} failed: ${res.status}`);
    }
    results.push({ name, ...(await res.json()) });
  }

  const profile = readProfileFromKeychain();
  if (profile) {
    let etag;
    const getRes = await authFetch(
      config,
      "/v1/profile",
      { method: "GET" },
      fetchImpl,
    );
    if (getRes.ok) {
      etag = getRes.headers.get("etag") ?? undefined;
    }
    const headers = { "content-type": "application/json" };
    if (etag) {
      headers["if-match"] = etag;
    }
    const putRes = await authFetch(
      config,
      "/v1/profile",
      {
        method: "PUT",
        body: JSON.stringify(profile),
        headers,
      },
      fetchImpl,
    );
    if (!putRes.ok) {
      throw new Error(`push profile failed: ${putRes.status}`);
    }
    results.push({ name: "profile", ...(await putRes.json()) });
  }

  return results;
}

export async function pullCommand(fetchImpl) {
  const config = await readConfig();
  if (!config?.url || !config?.token) {
    throw new Error("not configured; run enable first");
  }

  const stateDir = getStateDir();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const manifest = await getManifest(config, fetchImpl);
  const pulled = [];

  for (const entry of manifest) {
    const res = await authFetch(
      config,
      `/v1/files/${encodeURIComponent(entry.name)}`,
      { method: "GET" },
      fetchImpl,
    );
    if (!res.ok) {
      throw new Error(`pull ${entry.name} failed: ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const localPath = join(stateDir, entry.name);
    await writeFile(localPath, bytes, { mode: 0o600 });
    await chmod(localPath, 0o600);
    pulled.push(entry.name);
  }

  const profileRes = await authFetch(
    config,
    "/v1/profile",
    { method: "GET" },
    fetchImpl,
  );
  if (profileRes.ok) {
    const profile = JSON.parse(await profileRes.text());
    writeProfileToKeychain(profile);
    pulled.push("profile");
  }

  return pulled;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { stdinText = "", fetchImpl } = options;
  const [command, ...rest] = argv;

  switch (command) {
    case "enable":
      return enableCommand(rest, stdinText);
    case "status":
      return statusCommand(fetchImpl);
    case "push":
      return pushCommand(fetchImpl);
    case "pull":
      return pullCommand(fetchImpl);
    default:
      throw new Error(
        "usage: sync.mjs <enable|push|pull|status> [--url URL --token TOKEN]",
      );
  }
}
