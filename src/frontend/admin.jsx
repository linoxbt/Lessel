import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Box, Button, ButtonGroup, DynamicTable, Heading, Inline, Label, Lozenge, SectionMessage, Select, Spinner, Stack,
  Strong, Text, TextArea, Textfield, Toggle,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { ErrorMessage } from "./shared";

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
];

function SettingEditor({ name, help, value, onSave }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <Stack space="space.050">
      <Label labelFor={name}>{name}: {help}</Label>
      <TextArea id={name} value={text} onChange={e => { setText(e.target.value); setBad(false); }} />
      <Inline space="space.100">
        <Button onClick={() => { try { onSave(name, JSON.parse(text)); } catch { setBad(true); } }}>Save {name}</Button>
        {bad ? <Text>That isn't valid JSON.</Text> : null}
      </Inline>
    </Stack>
  );
}

function Agents({ view, act }) {
  const [agent, setAgent] = useState({ agent_id: "", display_name: "" });
  const [acc, setAcc] = useState({ product: "jira", accountId: "", agentId: "" });
  return (
    <Stack space="space.150">
      <DynamicTable
        head={{ cells: ["Agent", "Jira", "Bitbucket", "MCP", "Suspended"].map(c => ({ key: c, content: c })) }}
        rows={view.agents.map(a => {
          const of = p => view.accounts.filter(x => x.agent_id === a.agent_id && x.product === p).map(x => x.account_id).join(", ") || "missing";
          return { key: a.agent_id, cells: [
            { key: "Agent", content: <Strong>{a.display_name} ({a.agent_id})</Strong> },
            { key: "Jira", content: of("jira") }, { key: "Bitbucket", content: of("bitbucket") }, { key: "MCP", content: of("mcp") },
            { key: "Suspended", content: <Toggle isChecked={!!a.suspended} onChange={() => act("setSuspended", { agentId: a.agent_id, suspended: !a.suspended })} /> },
          ] };
        })}
      />
      <Inline space="space.100" alignBlock="end">
        <Textfield placeholder="agent id, e.g. brook" value={agent.agent_id} onChange={e => setAgent({ ...agent, agent_id: e.target.value })} />
        <Textfield placeholder="display name" value={agent.display_name} onChange={e => setAgent({ ...agent, display_name: e.target.value })} />
        <Button onClick={() => act("saveAgent", agent)}>Add agent</Button>
      </Inline>
      <Inline space="space.100" alignBlock="end">
        <Select options={["jira", "bitbucket", "mcp"].map(p => ({ label: p, value: p }))} defaultValue={{ label: "jira", value: "jira" }} onChange={o => setAcc({ ...acc, product: o.value })} />
        <Textfield placeholder="account id or UUID" value={acc.accountId} onChange={e => setAcc({ ...acc, accountId: e.target.value })} />
        <Select options={view.agents.map(a => ({ label: a.display_name, value: a.agent_id }))} onChange={o => setAcc({ ...acc, agentId: o.value })} />
        <Button onClick={() => act("addAccount", acc)}>Map account</Button>
      </Inline>
      <Text>An agent usually has three accounts: the Jira user it's assigned work as, the Bitbucket account that opens PRs, and the account its MCP client signs in with.</Text>
    </Stack>
  );
}

function App() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const act = async (name, payload) => {
    const r = await invoke(name, payload);
    if (r?.error) setError(r.error); else { setError(null); if (r?.settings) setView(r); else setNotice(`${name}: queued`); }
  };
  useEffect(() => { invoke("getSettings").then(r => (r?.error ? setError(r.error) : setView(r))); }, []);
  if (!view) return error ? <ErrorMessage error={error} /> : <Spinner />;
  const s = view.settings;
  return (
    <Stack space="space.300">
      <SectionMessage appearance="information" title="People are never scored">
        <Text>Lessel scores AI agents per kind of task. Human work only appears as an aggregate team baseline, shown when at least {s.teamBaseline.minContributors} people contributed. Person IDs appear only in the audit trail of staff actions.</Text>
      </SectionMessage>
      <ErrorMessage error={error} />
      {notice ? <SectionMessage appearance="success"><Text>{notice}</Text></SectionMessage> : null}
      <Inline space="space.100" alignBlock="center">
        <Text>Mode:</Text>
        <Lozenge appearance={s.enforcementMode === "enforcing" ? "success" : "moved"} isBold>{s.enforcementMode}</Lozenge>
        <Button onClick={() => act("saveSetting", { key: "enforcementMode", value: s.enforcementMode === "enforcing" ? "advisory" : "enforcing" })}>
          Switch to {s.enforcementMode === "enforcing" ? "advisory" : "enforcing"}
        </Button>
      </Inline>
      <Heading as="h3">Agents</Heading>
      <Agents view={view} act={act} />
      <Heading as="h3">Jobs</Heading>
      <ButtonGroup>
        <Button onClick={() => act("runJob", { type: "migrate" })}>Run migrations</Button>
        <Button onClick={() => act("runJob", { type: "backfill" })}>Backfill history</Button>
        <Button onClick={() => act("runJob", { type: "recompute-all" })}>Recompute all</Button>
      </ButtonGroup>
      <Text>Before enforcing: set the native minimum approvals on gated branches to 0, mark the Lessel check as Required (Bitbucket Premium), turn on "reset approvals when the source branch changes", and add the Lessel validator to the Ready to merge transition.</Text>
      <Heading as="h3">Settings</Heading>
      <Box>
        <Stack space="space.200">
          {EDITABLE.map(([name, help]) => (
            <SettingEditor key={name} name={name} help={help} value={s[name]} onSave={(key, value) => act("saveSetting", { key, value })} />
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
