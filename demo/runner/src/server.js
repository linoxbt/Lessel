// HTTP entry point: one A2A JSON-RPC route per agent (/a2a/atlas, /a2a/brook) plus /healthz.

import http from "node:http";
import { loadConfig } from "./config.js";
import { handleRpc, rpcError, ERR } from "./a2a.js";
import { TaskStore } from "./store.js";
import { makeVerifier, jiraBase } from "./fit.js";
import { Git } from "./git.js";
import { Bitbucket, Confluence, commentOnIssue } from "./atlassian.js";
import { Lessel } from "./lessel.js";
import { runAgent } from "./agent.js";
import { workOn, SerialQueue } from "./work.js";

const MAX_BODY = 1024 * 1024;

export function createServer(cfg, overrides = {}) {
  const store = overrides.store ?? new TaskStore(cfg.taskFile);
  // Without an app id the runner stays up (health checks pass) but refuses every A2A request.
  const verify = overrides.verify ?? (cfg.skipFit ? async () => ({})
    : cfg.forgeAppId && !/^<|0{8}-0{4}/.test(cfg.forgeAppId) ? makeVerifier({ appId: cfg.forgeAppId, jwksUrl: cfg.jwksUrl })
      : async () => { throw new Error("FORGE_APP_ID is not configured"); });
  if (!overrides.verify && !cfg.skipFit && !cfg.forgeAppId) console.warn("FORGE_APP_ID isn't set: every A2A request will be refused.");
  if (cfg.skipFit) console.warn("A2A_SKIP_FIT=1: Forge Invocation Tokens are NOT verified. Local testing only.");
  const queues = new Map();
  const routes = new Map(Object.values(cfg.agents).map(a => [a.route, a]));

  const depsFor = overrides.depsFor ?? ((agent, fit, systemToken) => {
    const bitbucket = new Bitbucket({ workspace: cfg.repo.workspace, slug: cfg.repo.slug, ...agent.bitbucket });
    return {
      git: new Git({ dir: agent.workdir, remoteUrl: bitbucket.cloneUrl(), authHeader: bitbucket.gitAuthHeader(),
        mainBranch: cfg.repo.mainBranch, ...agent.git }),
      bitbucket,
      confluence: new Confluence({ baseUrl: cfg.siteUrl, ...agent.confluence }),
      lessel: new Lessel({ url: cfg.lesselMcpUrl, tokenFile: agent.mcpTokenFile }),
      runAgent,
      mainBranch: cfg.repo.mainBranch,
      comment: text => commentOnIssue({ jiraBase: jiraBase(fit), systemToken, issueKey: fit.issueKey, text }),
    };
  });

  return http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") { res.writeHead(204).end(); return; }
    const agent = routes.get(url.pathname);
    if (!agent || req.method !== "POST") return send(404, { error: "not found" });

    let fit;
    try { fit = await verify(req.headers.authorization); } catch (e) {
      console.warn(`Rejected request to ${url.pathname}: ${e.message}`);
      return send(401, { error: "invalid Forge Invocation Token" });
    }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return send(413, { error: "request too large" });
        chunks.push(c);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(200, rpcError(null, ERR.PARSE, "Parse error"));
    }

    const systemToken = req.headers["x-forge-oauth-system"] ?? null;
    const response = await handleRpc(body, {
      store,
      agentId: agent.id,
      start: (task, inv) => {
        if (inv.agentAccountId && inv.agentAccountId !== "UNKNOWN") {
          console.log(`${agent.name}'s Jira account is ${inv.agentAccountId} (map it in Lessel settings).`);
        }
        const deps = depsFor(agent, { ...fit, issueKey: inv.issueKey }, systemToken);
        if (!queues.has(agent.id)) queues.set(agent.id, new SerialQueue());
        queues.get(agent.id).push(() => workOn(task, inv, agent, { ...deps, store }));
      },
    });
    return send(200, response);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  // Skipping token checks is for local testing: then the runner only listens on localhost.
  const host = cfg.skipFit ? "127.0.0.1" : undefined;
  createServer(cfg).listen(cfg.port, host, () =>
    console.log(`Lessel demo runner on :${cfg.port} — ${Object.values(cfg.agents).map(a => `${a.name} at ${a.route}`).join(", ")}`));
}
