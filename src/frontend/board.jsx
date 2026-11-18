import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Box, Button, DynamicTable, Heading, Inline, Lozenge, Modal, ModalBody, ModalHeader, ModalTitle, ModalTransition,
  Spinner, Stack, Strong, Tab, TabList, TabPanel, Tabs, Text, Textfield, Tooltip, SectionMessage, ButtonGroup,
  xcss,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { CAUSALITY_APPEARANCE, ErrorMessage, LevelLozenge, ModeBanner, pct, when } from "./shared";

function Cell({ cell, onOpen }) {
  if (!cell) return <Text>—</Text>;
  return (
    <Tooltip content={cell.sentence}>
      <Button appearance="subtle" spacing="compact" onClick={() => onOpen(cell)}>
        <Inline space="space.050" alignBlock="center">
          <LevelLozenge earned={cell.earned} effective={cell.effective} blocked={cell.blocked} />
          <Text>{cell.clean}/{cell.total} · {pct(cell.lower90)}{cell.probation ? " ▨" : ""}{cell.review ? " ⚑" : ""}</Text>
        </Inline>
      </Button>
    </Tooltip>
  );
}

function Evidence({ cell, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => { invoke("getEvidence", { agentId: cell.agentId, shapeId: cell.shapeId }).then(setData); }, [cell]);
  return (
    <Modal onClose={onClose} width="x-large">
      <ModalHeader><ModalTitle>{cell.agentId} on {cell.shapeId}</ModalTitle></ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>{cell.sentence}</Text>
          {!data ? <Spinner /> : (
            <DynamicTable
              head={{ cells: ["Item", "Outcome", "PRs", "Deployed", "Signals"].map(c => ({ key: c, content: c })) }}
              rows={data.items.map(i => ({ key: i.issueKey, cells: [
                { key: "Item", content: i.issueKey },
                { key: "Outcome", content: <Lozenge appearance={i.outcome === "clean" ? "success" : i.outcome === "failed" ? "removed" : i.outcome === "excused" ? "new" : "default"}>{i.outcome}{i.changedAfterWindow ? " (after window)" : ""}</Lozenge> },
                { key: "PRs", content: i.prs.map(p => `#${p.prId} ${p.state}`).join(", ") },
                { key: "Deployed", content: when(i.deployedAt) },
                { key: "Signals", content: (
                  <Stack space="space.050">
                    {i.signals.map(s => (
                      <Inline key={s.id} space="space.050" alignBlock="center">
                        <Text>{s.kind} {s.ref}</Text>
                        <Lozenge appearance={CAUSALITY_APPEARANCE[s.causality]}>{s.causality}</Lozenge>
                        {s.decidedBy ? <Text>by {s.decidedBy}{s.via ? ` (${s.via})` : ""}</Text> : null}
                      </Inline>
                    ))}
                  </Stack>
                ) },
              ] }))}
              rowsPerPage={10}
            />
          )}
          {data?.decisions?.length ? (
            <Stack space="space.050">
              <Heading as="h5">Decision changes</Heading>
              {data.decisions.map((d, i) => <Text key={String(i)}>{when(d.at)}: after {d.cause} → L{d.after.effective}{d.after.blocked ? ", blocked" : ""}</Text>)}
            </Stack>
          ) : null}
        </Stack>
      </ModalBody>
    </Modal>
  );
}

function Grid({ data }) {
  const [open, setOpen] = useState(null);
  const head = { cells: [{ key: "agent", content: "Agent" }, ...data.shapeIds.map(s => ({ key: s, content: s }))] };
  const rows = data.agents.map(a => ({ key: a.agentId, cells: [
    { key: "agent", content: <Inline space="space.050"><Strong>{a.name}</Strong>{a.suspended ? <Lozenge appearance="removed">suspended</Lozenge> : null}</Inline> },
    ...data.shapeIds.map(s => ({ key: s, content: <Cell cell={data.cells.find(c => c.agentId === a.agentId && c.shapeId === s)} onOpen={setOpen} /> })),
  ] }));
  rows.push({ key: "team", cells: [
    { key: "agent", content: <Strong>The team</Strong> },
    ...data.team.map(t => ({ key: t.shapeId, content: <Text>{t.text}</Text> })),
  ] });
  return (
    <Stack space="space.100">
      <DynamicTable head={head} rows={rows} />
      <Text>▨ probation · ⚑ suspected signal open · The team row is an aggregate; people are never scored individually.</Text>
      <ModalTransition>{open ? <Evidence cell={open} onClose={() => setOpen(null)} /> : null}</ModalTransition>
    </Stack>
  );
}

function CleanRoom() {
  const [sources, setSources] = useState(null);
  const [error, setError] = useState(null);
  const [input, setInput] = useState({});
  const run = async (name, payload) => {
    const r = await invoke(name, payload);
    if (r?.error) setError(r.error); else { setError(null); if (Array.isArray(r)) setSources(r); }
  };
  useEffect(() => { invoke("getSources").then(r => (r?.error ? setError(r.error) : setSources(r))); }, []);
  if (!sources) return error ? <ErrorMessage error={error} /> : <Spinner />;
  if (!sources.length) return <Text>No suspect or tainted sources.</Text>;
  return (
    <Stack space="space.200">
      <ErrorMessage error={error} />
      {sources.map(s => (
        <Box key={s.source_id} xcss={xcss({ padding: "space.150", borderColor: "color.border", borderWidth: "border.width", borderStyle: "solid", borderRadius: "border.radius" })}>
          <Stack space="space.100">
            <Inline space="space.100" alignBlock="center">
              <Strong>{s.title || s.url}</Strong>
              <Lozenge appearance={s.state === "suspect" ? "moved" : "removed"}>{s.state}</Lozenge>
              {s.range ? <Text>tainted {s.range}</Text> : null}
            </Inline>
            {s.findings.map(f => <Text key={f.finding_id}>v{f.version} · {f.filter}: “{f.quote}”</Text>)}
            <Inline space="space.100" alignBlock="end">
              <Textfield placeholder="first tainted version" value={input[`${s.source_id}:from`] ?? ""} onChange={e => setInput({ ...input, [`${s.source_id}:from`]: e.target.value })} />
              <Button onClick={() => run("confirmTaint", { sourceId: s.source_id, fromVersion: input[`${s.source_id}:from`] })}>Confirm taint</Button>
              <Textfield placeholder="first clean version" value={input[`${s.source_id}:fix`] ?? ""} onChange={e => setInput({ ...input, [`${s.source_id}:fix`]: e.target.value })} />
              <Button onClick={() => run("markFixed", { sourceId: s.source_id, cleanFromVersion: input[`${s.source_id}:fix`] })}>Mark fixed</Button>
              <Button appearance="subtle" onClick={() => run("dismissTaint", { sourceId: s.source_id })}>Not tainted</Button>
              {["confirmed", "restored"].includes(s.state) && s.source_id.startsWith("confluence:page:")
                ? <Button appearance="danger" onClick={() => run("quarantine", { sourceId: s.source_id })}>Quarantine</Button>
                : null}
              {s.tainted_from_version > 1 && s.state !== "restored" && s.source_id.startsWith("confluence:page:")
                ? <Button appearance="warning" onClick={() => run("restoreClean", { sourceId: s.source_id })}>Restore v{s.tainted_from_version - 1}</Button>
                : null}
            </Inline>
            <Heading as="h5">Blast radius</Heading>
            {s.blastRadius.length ? s.blastRadius.map(b => (
              <Text key={b.issue_key}>{b.issue_key} · {b.agent_id} · read v{b.versions.join(", v")} · {b.outcome}{b.prs.length ? ` · PR ${b.prs.map(p => `#${p.pr_id} ${p.state}`).join(", ")}` : ""}</Text>
            )) : <Text>No reads inside the tainted range.</Text>}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function History() {
  const [rows, setRows] = useState(null);
  useEffect(() => { invoke("getHistory").then(setRows); }, []);
  if (!rows) return <Spinner />;
  if (rows.error) return <ErrorMessage error={rows.error} />;
  if (!rows.length) return <Text>No level or eligibility changes yet.</Text>;
  return (
    <DynamicTable
      head={{ cells: ["When", "Agent", "Shape", "Change", "Because"].map(c => ({ key: c, content: c })) }}
      rows={rows.map((r, i) => ({ key: String(i), cells: [
        { key: "When", content: when(r.at) },
        { key: "Agent", content: r.agentId },
        { key: "Shape", content: r.shapeId },
        { key: "Change", content: r.after?.effective != null
          ? `L${r.before?.effective ?? "?"} → L${r.after.effective}${r.after.blocked ? " (blocked)" : ""}` : "context" },
        { key: "Because", content: r.cause },
      ] }))}
      rowsPerPage={20}
    />
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { invoke("getBoard").then(r => (r?.error ? setError(r.error) : setData(r))); }, []);
  if (!data) return error ? <ErrorMessage error={error} /> : <Spinner />;
  return (
    <Stack space="space.200">
      {data.importedNote ? <SectionMessage appearance="discovery" title="Imported history"><Text>{data.importedNote}</Text></SectionMessage> : null}
      <ModeBanner mode={data.mode} windowNote={data.windowNote} />
      <Tabs id="lessel-tabs">
        <TabList><Tab>Agents × shapes</Tab><Tab>Clean Room</Tab><Tab>History</Tab></TabList>
        <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}>{data.agents.length ? <Grid data={data} /> : <Text>No agents yet. Add them in Lessel settings.</Text>}</Box></TabPanel>
        <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}><CleanRoom /></Box></TabPanel>
        <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}><History /></Box></TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
