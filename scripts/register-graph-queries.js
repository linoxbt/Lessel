// Registers Lessel's saved Teamwork Graph queries for this app and prints the queryKeys to paste into
// Lessel settings (graphQueries). Run once after `forge register`, as an app contributor:
//   ATLASSIAN_SITE=https://<site>.atlassian.net ATLASSIAN_EMAIL=you@x ATLASSIAN_API_TOKEN=... \
//     node scripts/register-graph-queries.js
// Queries are immutable and deduplicated by text, so re-running returns the same keys.
// New keys take about a minute to become executable (QUERY_NOT_FOUND until then).
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { QUERIES } = require("../src/adapters/graph");

const site = process.env.ATLASSIAN_SITE?.replace(/\/$/, "");
const email = process.env.ATLASSIAN_EMAIL;
const token = process.env.ATLASSIAN_API_TOKEN;
if (!site || !email || !token) { console.error("Set ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN."); process.exit(2); }
const manifest = YAML.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.yml"), "utf8"));
const appId = manifest.app.id;
if (/0{8}-0{4}/.test(appId)) { console.error("Run `forge register` first: manifest.yml still has the placeholder app id."); process.exit(2); }

(async () => {
  const keys = {};
  for (const [setting, q] of Object.entries(QUERIES)) {
    const res = await fetch(`${site}/gateway/api/twg/cypher-queries`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appId, name: q.name, cypher: q.cypher, paramsSchema: q.paramsSchema }),
    });
    const body = await res.text();
    if (!res.ok) { console.error(`${q.name}: HTTP ${res.status} ${body.slice(0, 400)}`); process.exit(1); }
    keys[setting] = JSON.parse(body).queryKey;
    console.log(`${q.name}: ${keys[setting]} (${res.status === 201 ? "created" : "already registered"})`);
  }
  console.log(`\nIn Lessel settings, save graphQueries as:\n${JSON.stringify(keys, null, 2)}`);
})();
