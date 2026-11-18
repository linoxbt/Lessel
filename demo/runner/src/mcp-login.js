// One-time OAuth login to Lessel's MCP server for one agent: `npm run mcp-login -- brook`.
// Sign in as THAT agent's Atlassian service account in the browser, then map the account in Lessel
// settings as the agent's MCP account.

import http from "node:http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig } from "./config.js";
import { FileOAuthProvider, Lessel } from "./lessel.js";

const agentId = process.argv[2];
const cfg = loadConfig();
const agent = cfg.agents[agentId];
if (!agent) { console.error(`Usage: npm run mcp-login -- <${Object.keys(cfg.agents).join("|")}>`); process.exit(2); }

const port = 33418;
const provider = new FileOAuthProvider(agent.mcpTokenFile, {
  redirectUrl: `http://localhost:${port}/callback`,
  onRedirect: url => console.log(`\nOpen this URL and sign in as ${agent.name}'s Atlassian account:\n\n${url}\n`),
});

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const c = u.searchParams.get("code");
    res.writeHead(c ? 200 : 400, { "content-type": "text/plain" }).end(c ? "Signed in. You can close this tab." : "No code.");
    server.close();
    c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
  }).listen(port, async () => {
    try {
      const r = await auth(provider, { serverUrl: cfg.lesselMcpUrl });
      if (r === "AUTHORIZED") { server.close(); resolve(null); }
    } catch (e) { server.close(); reject(e); }
  });
});

if (code) await auth(provider, { serverUrl: cfg.lesselMcpUrl, authorizationCode: code });
const lessel = new Lessel({ url: cfg.lesselMcpUrl, tokenFile: agent.mcpTokenFile });
await lessel.connect();
console.log(`Logged in. Lessel tools: ${lessel.tools.join(", ")}`);
try { console.log(await lessel.call("get-my-scope", {})); } catch (e) { console.log(`get-my-scope: ${e.message}`); }
process.exit(0);
