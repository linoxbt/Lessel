import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Box, Button, ButtonGroup, Code, DynamicTable, Heading, Inline, Label, Lozenge, SectionMessage, Select, Spinner,
  Stack, Strong, Text, TextArea, Textfield, Toggle,
} from "@forge/react";
import { ErrorMessage, Loaded, call, useCall, when } from "./shared";

const EDITABLE = [
  ["enforcementMode", "advisory or enforcing"],
  ["approvalsByLevel", "Human approvals by effective level"],
  ["humanPrMinApprovals", "Approvals for human PRs (repository rule, not a score)"],
  ["levels", "Level thresholds"],
  ["windowHours", "Observation window in hours (default 336; demo 72, labelled)"],
  ["windowEnvironment", "Deployment environment type that opens the window"],
  ["repos", "Per repo: { uuid: { workspace, deploys, defaultService, mainBranch } }"],
  ["projectKeys", "Jira project keys Lessel tracks"],
  ["incidentProjects", "Incident projects"],
  ["bugIssueTypes", "Bug issue types"],
  ["causedByLinkType", "Caused-by link type name"],
  ["linkConfirms", "Caused-by link confirms automatically"],
  ["severity", "Severity field and value map"],
  ["servicePaths", "Service path map"],
  ["criticalServices", "Critical services"],
  ["classPaths", "Change-class path map"],
  ["probationClean", "Clean outcomes to clear probation"],
  ["suspectedExpiryHours", "Hours after the window before suspected signals expire"],
  ["teamBaseline", "Team baseline floors"],
  ["cleanRoom", "Clean Room scope and allowed link domains"],
  ["ai", "AI provider: \"qwen\" (Fortytwo, needs FORTYTWO_API_KEY) or \"forge\" (Forge LLMs); llmScan: suspect | all | off"],
  ["graphQueries", "Teamwork Graph saved-query keys (from scripts/register-graph-queries.js)"],
];

/**
 * One setting as JSON. The text follows the saved value: when the value changes (this editor's save, the mode
 * switch, an import), the editor shows the new value, so saving an old editor can't silently undo a change.
 */
function SettingEditor({ name, help, value, onSave }) {
  const saved = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(saved);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(saved); }, [saved]);
  const save = async () => {
    let parsed;
    try { parsed = JSON.parse(text); } catch { setMsg({ error: "That isn't valid JSON." }); return; }
    setBusy(true);
    const r = await onSave(name, parsed);
    setBusy(false);
    setMsg(r.error ? { error: `Not saved: ${r.error}` } : { ok: "Saved." });
  };
  return (
    <Stack space="space.050">
      <Label labelFor={name}>{name}: {help}</Label>
      <TextArea id={name} value={text} onChange={e => { setText(e.target.value); setMsg(null); }} />
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={busy || text === saved} onClick={save}>Save {name}</Button>
        {text !== saved ? <Button appearance="subtle" isDisabled={busy} onClick={() => { setText(saved); setMsg(null); }}>Discard changes</Button> : null}
        {msg?.ok ? <Text>{msg.ok}</Text> : null}
      </Inline>
      {msg?.error ? <ErrorMessage error={msg.error} /> : null}
    </Stack>
  );
}

function Accounts({ list, act, busy }) {
  if (!list.length) return <Text>missing</Text>;
  return (
    <Stack space="space.025">
      {list.map(x => (
        <Inline key={`${x.product}:${x.account_id}`} space="space.050" alignBlock="center">
          <Text>{x.account_id}</Text>
          <Button appearance="subtle" spacing="compact" isDisabled={busy}
            onClick={() => act("removeAccount", { product: x.product, accountId: x.account_id })}>Remove</Button>
        </Inline>
      ))}
    </Stack>
  );
}

function Agents({ view, act }) {
  const [agent, setAgent] = useState({ agent_id: "", display_name: "" });
  const [acc, setAcc] = useState({ product: "jira", accountId: "", agentId: "" });
  const [busy, setBusy] = useState(false);
  const run = async (name, payload) => { setBusy(true); const r = await act(name, payload); setBusy(false); return r; };
  return (
    <Stack space="space.150">
      <DynamicTable
        head={{ cells: ["Agent", "Jira", "Bitbucket", "MCP", "Suspended"].map(c => ({ key: c, content: c })) }}
        rows={view.agents.map(a => {
          const of = p => <Accounts list={view.accounts.filter(x => x.agent_id === a.agent_id && x.product === p)} act={run} busy={busy} />;
          return { key: a.agent_id, cells: [
            { key: "Agent", content: <Strong>{a.display_name} ({a.agent_id})</Strong> },
            { key: "Jira", content: of("jira") }, { key: "Bitbucket", content: of("bitbucket") }, { key: "MCP", content: of("mcp") },
            { key: "Suspended", content: <Toggle isChecked={!!a.suspended} isDisabled={busy} onChange={() => run("setSuspended", { agentId: a.agent_id, suspended: !a.suspended })} /> },
          ] };
        })}
      />
      <Inline space="space.100" alignBlock="end">
        <Textfield placeholder="agent id, e.g. brook" value={agent.agent_id} onChange={e => setAgent({ ...agent, agent_id: e.target.value })} />
        <Textfield placeholder="display name" value={agent.display_name} onChange={e => setAgent({ ...agent, display_name: e.target.value })} />
        <Button isDisabled={busy || !agent.agent_id.trim() || !agent.display_name.trim()} onClick={() => run("saveAgent", agent)}>Add agent</Button>
      </Inline>
      <Inline space="space.100" alignBlock="end">
        <Select options={["jira", "bitbucket", "mcp"].map(p => ({ label: p, value: p }))} defaultValue={{ label: "jira", value: "jira" }} onChange={o => setAcc({ ...acc, product: o.value })} />
        <Textfield placeholder="account id or UUID" value={acc.accountId} onChange={e => setAcc({ ...acc, accountId: e.target.value })} />
        <Select options={view.agents.map(a => ({ label: a.display_name, value: a.agent_id }))} onChange={o => setAcc({ ...acc, agentId: o.value })} />
        <Button isDisabled={busy || !acc.accountId.trim() || !acc.agentId} onClick={() => run("addAccount", acc)}>Map account</Button>
      </Inline>
      <Text>An agent usually has three accounts: the Jira user it's assigned work as, the Bitbucket account that opens PRs, and the account its MCP client signs in with. Removing an account is logged.</Text>
    </Stack>
  );
}

const STATUS = { ok: "success", warn: "moved", fail: "removed", manual: "new", info: "default" };

function SetupCheck() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const r = await call("getReadiness");
    setBusy(false);
    if (r.error) setError(r.error); else { setError(null); setRows(r.data); }
  };
  return (
    <Stack space="space.100">
      <Button onClick={run} isDisabled={busy}>{busy ? "Checking…" : "Run setup check"}</Button>
      <ErrorMessage error={error} onRetry={busy ? null : run} />
      {Array.isArray(rows) ? (
        <DynamicTable
          head={{ cells: [{ key: "s", content: "Status" }, { key: "t", content: "Check" }, { key: "d", content: "Detail" }] }}
          rows={rows.map(r => ({ key: r.id, cells: [
            { key: "s", content: <Lozenge appearance={STATUS[r.status]}>{r.status}</Lozenge> },
            { key: "t", content: r.title },
            { key: "d", content: r.detail },
          ] }))}
        />
      ) : null}
    </Stack>
  );
}

const JOBS = [["migrate", "Run migrations"], ["backfill", "Backfill history"], ["recompute-all", "Recompute all"]];

/** Always shown, even when the rest of the page can't load: a fresh install needs "Run migrations" first. */
function Jobs({ act }) {
  const [busy, setBusy] = useState(null);
  const run = async (type, label) => {
    setBusy(type);
    await act("runJob", { type }, `${label}: queued. Jobs run in the background; give it a minute, then reload.`);
    setBusy(null);
  };
  return (
    <Stack space="space.100">
      <ButtonGroup>
        {JOBS.map(([type, label]) => <Button key={type} isDisabled={!!busy} onClick={() => run(type, label)}>{label}</Button>)}
      </ButtonGroup>
      <Text>Before enforcing: set the native minimum approvals on gated branches to 0, mark the Lessel check as Required (Bitbucket Premium), turn on "reset approvals when the source branch changes", and add the Lessel validator to the Ready to merge transition.</Text>
    </Stack>
  );
}

const LINKS = [
  { target: "bitbucket", name: "Bitbucket", where: "Paste this in Lessel for Bitbucket → Workspace settings → Lessel." },
  { target: "confluence", name: "Confluence", where: "Paste this in Confluence → Settings → Lessel." },
  { target: "runner", name: "Agent runner (optional)", where: "Give this to the runner that hosts your own agents: it carries the bridge address (LESSEL_BRIDGE_URL) and its secret (LESSEL_RUNNER_SECRET). It can only report reads and ask for ticket fit, for agents registered with kind \"runner\"." },
];

/** Links from this installation (which holds Lessel's data) to Lessel for Bitbucket and Lessel in Confluence. */
function Links() {
  const state = useCall("linkStatus");
  const [codes, setCodes] = useState({});
  const [confirmUnlink, setConfirmUnlink] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const create = async target => {
    setBusy(true);
    const r = await call("createPairingCode", { target });
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setError(null);
    setCodes(c => ({ ...c, [target]: r.data.code }));
    if (r.data.status) state.setData(r.data.status);
  };
  const unlink = async target => {
    setBusy(true);
    const r = await call("unlink", { target });
    setBusy(false);
    setConfirmUnlink(null);
    if (r.error) { setError(r.error); return; }
    setError(null);
    setCodes(c => ({ ...c, [target]: null }));
    state.setData(r.data);
  };
  return (
    <Stack space="space.150">
      <Text>Lessel keeps its data in this Jira installation. Lessel for Bitbucket and Lessel's Confluence installation each link to it once, with a pairing code created here.</Text>
      <ErrorMessage error={error} />
      <Loaded state={state}>{status => (
        <Stack space="space.200">
          {LINKS.map(l => {
            const s = status?.[l.target] ?? {};
            return (
              <Stack key={l.target} space="space.100">
                <Inline space="space.100" alignBlock="center">
                  <Strong>{l.name}</Strong>
                  <Lozenge appearance={s.linked ? "success" : s.pending ? "moved" : "default"}>{s.linked ? "linked" : s.pending ? "waiting for the code" : "not linked"}</Lozenge>
                  {s.linked ? <Text>{s.workspace ? `Workspace ${s.workspace}, l` : "L"}inked {when(s.linkedAt)}</Text> : null}
                </Inline>
                <ButtonGroup>
                  <Button isDisabled={busy} onClick={() => create(l.target)}>{s.linked ? "Create a new pairing code" : "Create pairing code"}</Button>
                  {s.linked || s.pending ? <Button appearance="subtle" isDisabled={busy} onClick={() => setConfirmUnlink(l.target)}>Unlink</Button> : null}
                </ButtonGroup>
                {confirmUnlink === l.target ? (
                  <SectionMessage appearance="warning" title={`Unlink ${l.name}?`}>
                    <Stack space="space.100">
                      <Text>{l.target === "bitbucket"
                        ? "Lessel for Bitbucket will stop getting verdicts from this site, and its merge check fails closed until you link again."
                        : "Confluence page events will stop reaching Lessel, so the Clean Room won't see new page versions until you link again."}</Text>
                      <ButtonGroup>
                        <Button appearance="danger" isDisabled={busy} onClick={() => unlink(l.target)}>Unlink</Button>
                        <Button appearance="subtle" onClick={() => setConfirmUnlink(null)}>Cancel</Button>
                      </ButtonGroup>
                    </Stack>
                  </SectionMessage>
                ) : null}
                {codes[l.target] ? (
                  <SectionMessage appearance="information" title={`Pairing code for ${l.name}`}>
                    <Stack space="space.100">
                      <Code>{codes[l.target]}</Code>
                      <Text>{l.where}</Text>
                    </Stack>
                  </SectionMessage>
                ) : null}
              </Stack>
            );
          })}
        </Stack>
      )}</Loaded>
    </Stack>
  );
}

const ACTIVE = new Set(["queued", "running"]);

function ImportStatus({ st }) {
  if (!st || st.state === "none") return null;
  if (st.state === "queued") return <Inline space="space.100" alignBlock="center"><Spinner size="small" /><Text>Import queued {when(st.queuedAt)}. It runs in the background; this updates by itself.</Text></Inline>;
  if (st.state === "running") return <Inline space="space.100" alignBlock="center"><Spinner size="small" /><Text>Importing since {when(st.startedAt)}…</Text></Inline>;
  if (st.state === "failed") return <ErrorMessage error={`The import failed${st.finishedAt ? ` (${when(st.finishedAt)})` : ""}: ${st.error ?? "unknown error"}`} />;
  const n = st.imported ?? {};
  return (
    <SectionMessage appearance="success" title="History imported">
      <Text>
        Imported {n.work_items ?? 0} work items, {n.signals ?? 0} signals and {n.records ?? 0} records ({when(st.finishedAt)}).
        {st.keyPrefix ? ` Imported keys start with ${st.keyPrefix} (PAY-212 became ${st.keyPrefix}PAY-212).` : ""} Open any project's Lessel page to see them.
      </Text>
    </SectionMessage>
  );
}

function Snapshot({ onImported }) {
  const status = useCall("importStatus");
  const [out, setOut] = useState("");
  const [paste, setPaste] = useState("");
  const [prefix, setPrefix] = useState("DEMO");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const st = status.data;
  const active = !!st && ACTIVE.has(st.state);

  // Poll while an import is queued or running.
  useEffect(() => {
    if (!active || status.loading) return undefined;
    const t = setTimeout(status.retry, 3000);
    return () => clearTimeout(t);
  }, [active, status.loading, st]);
  // The import changed settings (mode, imported banner): reload them once it's done.
  useEffect(() => {
    if (watching && st && !ACTIVE.has(st.state)) { setWatching(false); if (st.state === "done") onImported(); }
  }, [watching, st]);

  const doExport = async () => {
    setBusy(true);
    const r = await call("exportSnapshot");
    setBusy(false);
    if (r.error) setError(r.error); else { setError(null); setOut(r.data.json); }
  };
  const doImport = async () => {
    setBusy(true);
    const r = await call("importSnapshot", { json: paste, keyPrefix: prefix.trim() });
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setError(null);
    setPaste("");
    setWatching(true);
    status.setData(r.data);
  };
  return (
    <Stack space="space.100">
      <Text>Export copies this site's agent history without any account id (no person's, and no agent's: only agent names). Import works only on a fresh install, runs in the background, and labels the board "Imported history". Imported work items get a key prefix so they never clash with this site's own tickets, and imported pull requests are never looked up in Bitbucket.</Text>
      <ErrorMessage error={error} />
      {status.error ? <ErrorMessage error={`Couldn't read the import status: ${status.error}`} onRetry={status.retry} /> : null}
      <ImportStatus st={st} />
      <ButtonGroup>
        <Button isDisabled={busy} onClick={doExport}>Export snapshot</Button>
      </ButtonGroup>
      {out ? <TextArea value={out} isReadOnly /> : null}
      <TextArea placeholder="Paste a snapshot here to import it" value={paste} onChange={e => setPaste(e.target.value)} />
      <Inline space="space.100" alignBlock="end">
        <Stack space="space.025">
          <Label labelFor="lessel-key-prefix">Key prefix for imported work items</Label>
          <Textfield id="lessel-key-prefix" value={prefix} onChange={e => setPrefix(e.target.value.toUpperCase())} />
        </Stack>
        <Button appearance="primary" isDisabled={busy || active || !paste.trim() || !/^[A-Z]{2,8}$/.test(prefix.trim())} onClick={doImport}>Import pasted snapshot</Button>
      </Inline>
    </Stack>
  );
}

function App() {
  const settings = useCall("getSettings");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  /** Run an admin action; a result with settings in it refreshes the page. */
  const act = async (name, payload, doneText) => {
    const r = await call(name, payload);
    if (r.error) { setError(r.error); setNotice(null); return r; }
    setError(null);
    if (r.data?.settings) settings.setData(r.data);
    if (doneText) setNotice(doneText);
    return r;
  };
  /** Saving one setting: its error shows next to its editor, not at the top. */
  const save = async (key, value) => {
    const r = await call("saveSetting", { key, value });
    if (!r.error && r.data?.settings) settings.setData(r.data);
    return r;
  };
  const view = settings.data;
  const s = view?.settings;
  return (
    <Stack space="space.300">
      <SectionMessage appearance="information" title="People are never scored">
        <Text>Lessel scores AI agents per kind of task. Human work only appears as an aggregate team baseline, shown when at least {s?.teamBaseline?.minContributors ?? 3} people contributed. Person IDs appear only in the audit trail of staff actions.</Text>
      </SectionMessage>
      <ErrorMessage error={error} />
      {notice ? <SectionMessage appearance="success"><Text>{notice}</Text></SectionMessage> : null}
      {!view ? (
        settings.error ? (
          <ErrorMessage
            error={`Lessel's settings couldn't be loaded: ${settings.error} If Lessel was just installed and its tables are missing, click Run migrations under Jobs below, wait a minute, then retry.`}
            onRetry={settings.retry} />
        ) : <Spinner />
      ) : (
        <Stack space="space.300">
          <ErrorMessage error={settings.error} onRetry={settings.retry} />
          <Inline space="space.100" alignBlock="center">
            <Text>Mode:</Text>
            <Lozenge appearance={s.enforcementMode === "enforcing" ? "success" : "moved"} isBold>{s.enforcementMode}</Lozenge>
            <Button onClick={() => act("saveSetting", { key: "enforcementMode", value: s.enforcementMode === "enforcing" ? "advisory" : "enforcing" })}>
              Switch to {s.enforcementMode === "enforcing" ? "advisory" : "enforcing"}
            </Button>
          </Inline>
          <Heading as="h3">Setup check</Heading>
          <SetupCheck />
          <Heading as="h3">Agents</Heading>
          <Agents view={view} act={act} />
        </Stack>
      )}
      <Heading as="h3">Jobs</Heading>
      <Jobs act={act} />
      <Heading as="h3">Links</Heading>
      <Links />
      <Heading as="h3">History snapshot (for judges)</Heading>
      <Snapshot onImported={settings.retry} />
      {view ? (
        <Stack space="space.200">
          <Heading as="h3">Settings</Heading>
          <Box>
            <Stack space="space.200">
              {EDITABLE.map(([name, help]) => (
                <SettingEditor key={name} name={name} help={help} value={s[name]} onSave={save} />
              ))}
            </Stack>
          </Box>
        </Stack>
      ) : null}
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
