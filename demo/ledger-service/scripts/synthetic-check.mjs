// Synthetic check against staging. On failure it opens a JSM incident in the INC project and exits 1.
// Repository variables: STAGING_URL, JIRA_BASE_URL (https://<site>.atlassian.net), JIRA_EMAIL,
// JIRA_API_TOKEN (secured), INCIDENT_PROJECT (default INC), INCIDENT_ISSUE_TYPE (default Incident),
// INCIDENT_COMPONENT (default ledger; Lessel uses it to mark "same service").

const base = process.env.STAGING_URL;
const commit = process.env.BITBUCKET_COMMIT ?? "unknown";
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const steps = [
  ["health", async () => {
    const h = await call("GET", "/health");
    if (!(h.max_rps > 0)) throw new Error(`max_rps is ${h.max_rps}; every request will be rate limited`);
  }],
  ["create accounts", async () => {
    await call("POST", "/accounts", { id: `syn_a_${run}`, owner: "synthetic", currency: "USD" });
    await call("POST", "/accounts", { id: `syn_b_${run}`, owner: "synthetic", currency: "USD" });
  }],
  ["transfer", () => call("POST", "/transfers", { id: `syn_t_${run}`, from: `syn_a_${run}`, to: `syn_b_${run}`, amount: 10000, currency: "USD" })],
  ["balance", async () => {
    const b = await call("GET", `/accounts/syn_b_${run}/balance`);
    const usd = b.balances.find(x => x.currency === "USD")?.amount;
    if (usd !== 10000) throw new Error(`expected balance 10000, got ${usd}`);
  }],
];

async function openIncident(step, error) {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) { console.error("No Jira credentials; not opening an incident."); return; }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const text = `Synthetic check failed at step "${step}" on staging, commit ${commit}.\n\n${error}`;
  const fields = {
    project: { key: process.env.INCIDENT_PROJECT ?? "INC" },
    issuetype: { name: process.env.INCIDENT_ISSUE_TYPE ?? "Incident" },
    summary: `Staging synthetic check failed: ${step} (${commit.slice(0, 8)})`,
    priority: { name: "High" },
    components: [{ name: process.env.INCIDENT_COMPONENT ?? "ledger" }],
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  };
  const create = f => fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ fields: f }),
  });
  let res = await create(fields);
  let body = await res.text();
  // A missing component or priority scheme must never stop the incident from being opened: retry without them.
  if (!res.ok && /components|priority/.test(body)) {
    console.error(`Retrying without component/priority: ${body.slice(0, 200)}`);
    const { components, priority, ...rest } = fields;
    res = await create(rest);
    body = await res.text();
  }
  if (!res.ok) console.error(`Couldn't open incident: ${res.status} ${body.slice(0, 300)}`);
  else console.log(`Opened incident ${JSON.parse(body).key}`);
}

if (!base) { console.error("Set STAGING_URL."); process.exit(2); }
for (const [name, fn] of steps) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    await openIncident(name, e.message);
    process.exit(1);
  }
}
console.log("Synthetic check passed.");
