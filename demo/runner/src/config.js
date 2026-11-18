// Runner configuration: agents.json (no secrets) + environment variables (secrets).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LLM } from "./llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

/** Config from RUNNER_CONFIG_JSON (hosted), else RUNNER_CONFIG / agents.json (local). */
export function loadConfig(file = process.env.RUNNER_CONFIG ?? path.join(ROOT, "agents.json")) {
  const raw = process.env.RUNNER_CONFIG_JSON ? JSON.parse(process.env.RUNNER_CONFIG_JSON) : JSON.parse(readFileSync(file, "utf8"));
  const dataDir = path.resolve(ROOT, process.env.RUNNER_DATA_DIR ?? raw.dataDir ?? "data");
  const agents = {};
  for (const [id, a] of Object.entries(raw.agents ?? {})) {
    const env = k => (a[k] ? process.env[a[k]] : undefined);
    agents[id] = {
      id,
      name: a.name ?? id,
      route: a.route ?? `/a2a/${id}`,
      persona: a.persona ?? "careful",
      llm: { ...DEFAULT_LLM, ...(raw.llm ?? {}), ...(a.llm ?? {}) },   // Qwen on Fortytwo unless overridden
      effort: a.effort ?? "high",
      maxIterations: a.maxIterations ?? 40,
      git: { authorName: a.gitAuthorName ?? `${a.name ?? id} (agent)`, authorEmail: a.gitAuthorEmail ?? `${id}@agents.invalid` },
      bitbucket: { email: a.bitbucketEmail, token: env("bitbucketTokenEnv") },
      confluence: { email: a.atlassianEmail, token: env("atlassianTokenEnv") },
      workdir: path.join(dataDir, "work", id, raw.repo?.slug ?? "repo"),
      mcpTokenFile: path.join(dataDir, "secrets", `mcp-${id}.json`),
    };
  }
  return {
    port: Number(process.env.PORT ?? raw.port ?? 8787),
    forgeAppId: process.env.FORGE_APP_ID ?? raw.forgeAppId,
    jwksUrl: process.env.FORGE_JWKS_URL ?? raw.jwksUrl,
    skipFit: process.env.A2A_SKIP_FIT === "1",
    siteUrl: raw.siteUrl,
    lesselMcpUrl: raw.lesselMcpUrl,
    repo: { workspace: raw.repo?.workspace, slug: raw.repo?.slug, mainBranch: raw.repo?.mainBranch ?? "main" },
    taskFile: path.join(dataDir, "tasks.json"),
    agents,
  };
}
