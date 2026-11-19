import React, { useState } from "react";
import ForgeReconciler, {
  Box, Button, ButtonGroup, DynamicTable, Heading, Inline, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle,
  ModalTransition, SectionMessage, Stack, Strong, Tab, TabList, TabPanel, Tabs, Text, Textfield, Tooltip, xcss,
} from "@forge/react";
import {
  CAUSALITY_APPEARANCE, ErrorMessage, LevelLozenge, Loaded, ModeBanner, call, expiryText, pct, useCall, when,
} from "./shared";

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

const OUTCOME_APPEARANCE = { clean: "success", failed: "removed", excused: "new" };
const OPEN = new Set(["associated", "suspected"]);

function prText(p) {
  const rev = p.state === "merged" && p.mergeCommit ? `merge ${p.mergeCommit.slice(0, 10)}` : p.head ? `head ${p.head.slice(0, 10)}` : null;
  return `#${p.prId} ${p.state}${rev ? ` · ${rev}` : ""}`;
}

function windowText(i) {
  if (i.windowStart) return `${when(i.windowStart)} → ${when(i.windowEnds)}`;
  if (i.mergedAt) return `merged ${when(i.mergedAt)}; window not open yet`;
  return "not merged";
}

/** One signal in the drawer, with Confirm / Dismiss while it's open and Reopen once decided. */
function SignalLine({ s, item, busy, act }) {
  const [reopening, setReopening] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Stack space="space.050">
      <Inline space="space.050" alignBlock="center">
        <Text>{s.kind} {s.ref}</Text>
        <Lozenge appearance={CAUSALITY_APPEARANCE[s.causality]}>{s.expired ? "expired, nobody decided" : s.causality}</Lozenge>
        {s.rev ? <Text>rev {s.rev}</Text> : null}
      </Inline>
      {s.decidedBy && !s.expired ? <Text>by {s.decidedBy}{s.via ? ` (${s.via})` : ""}, {when(s.decidedAt)}</Text> : null}
      {s.causality === "suspected" ? <Text>{expiryText(s)}</Text> : null}
      {item.hidden ? null : OPEN.has(s.causality) ? (
        <ButtonGroup>
          <Button appearance="danger" spacing="compact" isDisabled={busy || !item.canConfirm} onClick={() => act("confirmCause", { signalId: s.id })}>Confirm cause</Button>
          <Button spacing="compact" isDisabled={busy} onClick={() => act("dismissCause", { signalId: s.id })}>Dismiss</Button>
        </ButtonGroup>
      ) : reopening ? (
        <Inline space="space.050" alignBlock="center">
          <Textfield placeholder="Why reopen? (admins; audited)" value={note} onChange={e => setNote(e.target.value)} />
          <Button spacing="compact" appearance="primary" isDisabled={busy || !note.trim()}
            onClick={async () => { if (await act("reopenDecision", { signalId: s.id, note })) { setReopening(false); setNote(""); } }}>Reopen</Button>
          <Button spacing="compact" appearance="subtle" onClick={() => setReopening(false)}>Cancel</Button>
        </Inline>
      ) : (
        <Button appearance="subtle" spacing="compact" onClick={() => setReopening(true)}>Reopen decision</Button>
      )}
    </Stack>
  );
}

function Evidence({ cell, onClose }) {
  const ev = useCall("getEvidence", { agentId: cell.agentId, shapeId: cell.shapeId }, [cell.agentId, cell.shapeId]);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState(null);
  const [changed, setChanged] = useState(false);
  const act = async (name, payload) => {
    setBusy(true);
    const r = await call(name, { ...payload, view: "evidence", agentId: cell.agentId, shapeId: cell.shapeId });
    setBusy(false);
    if (r.error) { setActError(r.error); return false; }
    setActError(null);
    setChanged(true);
    ev.setData(r.data);
    return true;
  };
  const close = () => onClose(changed);
  return (
    <Modal onClose={close} width="x-large">
      <ModalHeader><ModalTitle>{cell.agentId} on {cell.shapeId}</ModalTitle></ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>{cell.sentence}</Text>
          <ErrorMessage error={actError} />
          <Loaded state={ev}>{data => (
            <Stack space="space.200">
              {data.windowNote ? <Text>{data.windowNote}.</Text> : null}
              {data.items.length ? (
                <DynamicTable
                  head={{ cells: ["Item", "Outcome", "PRs", "Window", "Signals"].map(c => ({ key: c, content: c })) }}
                  rows={data.items.map(i => ({ key: i.key, cells: [
                    { key: "Item", content: <Text>{i.label}{i.imported ? " (imported)" : ""}</Text> },
                    { key: "Outcome", content: (
                      <Stack space="space.050">
                        <Lozenge appearance={OUTCOME_APPEARANCE[i.outcome] ?? "default"}>{i.outcome}{i.changedAfterWindow ? " (after window)" : ""}</Lozenge>
                        {i.possibleBadInput ? <Tooltip content="A read for this item falls inside a tainted range but can't excuse it automatically. A person should look."><Lozenge appearance="moved">possible bad input</Lozenge></Tooltip> : null}
                      </Stack>
                    ) },
                    { key: "PRs", content: <Text>{i.prs.map(prText).join(", ") || "—"}</Text> },
                    { key: "Window", content: <Text>{windowText(i)}</Text> },
                    { key: "Signals", content: i.signals.length ? (
                      <Stack space="space.100">
                        {i.signals.map(s => <SignalLine key={s.id} s={s} item={i} busy={busy} act={act} />)}
                      </Stack>
                    ) : <Text>—</Text> },
                  ] }))}
                  rowsPerPage={10}
                />
              ) : <Text>No work items on this shape yet.</Text>}
              {data.decisions?.length ? (
                <Stack space="space.050">
                  <Heading as="h5">Decision changes</Heading>
                  {data.decisions.map((d, n) => <Text key={String(n)}>{when(d.at)}: after {d.cause} → L{d.after?.effective ?? "?"}{d.after?.blocked ? ", blocked" : ""}</Text>)}
                </Stack>
              ) : null}
            </Stack>
          )}</Loaded>
        </Stack>
      </ModalBody>
      <ModalFooter><Button onClick={close}>Close</Button></ModalFooter>
    </Modal>
  );
}

function Grid({ data, onChanged }) {
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
      <ModalTransition>
        {open ? <Evidence cell={open} onClose={changed => { setOpen(null); if (changed) onChanged(); }} /> : null}
      </ModalTransition>
    </Stack>
  );
}

function CleanRoom() {
  const state = useCall("getSources");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState({});
  const run = async (name, payload) => {
    setBusy(true);
    const r = await call(name, payload);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setError(null);
    if (Array.isArray(r.data)) state.setData(r.data);
  };
  return (
    <Loaded state={state}>{sources => (
      !sources.length ? <Text>No suspect or tainted sources.</Text> : (
        <Stack space="space.200">
          <ErrorMessage error={error} />
          {sources.map(s => (
            <Box key={s.source_id} xcss={xcss({ padding: "space.150", borderColor: "color.border", borderWidth: "border.width", borderStyle: "solid", borderRadius: "border.radius" })}>
              <Stack space="space.100">
                <Inline space="space.100" alignBlock="center">
                  <Strong>{s.title || s.url}</Strong>
                  <Lozenge appearance={s.state === "suspect" ? "moved" : "removed"}>{s.state}</Lozenge>
                  {s.range ? <Text>tainted {s.range}</Text> : null}
                  {s.source_id.startsWith("imported:") ? <Lozenge>imported</Lozenge> : null}
                </Inline>
                {s.confirmedBy ? <Text>Confirmed by {s.confirmedBy}{s.confirmed_at ? `, ${when(s.confirmed_at)}` : ""}.</Text> : null}
                {s.findings.map(f => <Text key={f.finding_id}>v{f.version} · {f.filter}: “{f.quote}”</Text>)}
                <Inline space="space.100" alignBlock="end">
                  <Textfield placeholder="first tainted version" value={input[`${s.source_id}:from`] ?? ""} onChange={e => setInput({ ...input, [`${s.source_id}:from`]: e.target.value })} />
                  <Button isDisabled={busy} onClick={() => run("confirmTaint", { sourceId: s.source_id, fromVersion: input[`${s.source_id}:from`] })}>Confirm taint</Button>
                  <Textfield placeholder="first clean version" value={input[`${s.source_id}:fix`] ?? ""} onChange={e => setInput({ ...input, [`${s.source_id}:fix`]: e.target.value })} />
                  <Button isDisabled={busy} onClick={() => run("markFixed", { sourceId: s.source_id, cleanFromVersion: input[`${s.source_id}:fix`] })}>Mark fixed</Button>
                  <Button appearance="subtle" isDisabled={busy} onClick={() => run("dismissTaint", { sourceId: s.source_id })}>Not tainted</Button>
                  {["confirmed", "restored"].includes(s.state) && s.source_id.startsWith("confluence:page:")
                    ? <Button appearance="danger" isDisabled={busy} onClick={() => run("quarantine", { sourceId: s.source_id })}>Quarantine</Button>
                    : null}
                  {s.tainted_from_version > 1 && s.state !== "restored" && s.source_id.startsWith("confluence:page:")
                    ? <Button appearance="warning" isDisabled={busy} onClick={() => run("restoreClean", { sourceId: s.source_id })}>Restore v{s.tainted_from_version - 1}</Button>
                    : null}
                </Inline>
                <Heading as="h5">Blast radius</Heading>
                {s.blastRadius.length ? s.blastRadius.map((b, n) => (
                  <Text key={`${b.issue_key}:${n}`}>{b.issue_key} · {b.agent_id} · read v{b.versions.join(", v")} · {b.outcome}{b.prs.length ? ` · PR ${b.prs.map(p => `#${p.pr_id} ${p.state}`).join(", ")}` : ""}</Text>
                )) : <Text>No reads inside the tainted range.</Text>}
              </Stack>
            </Box>
          ))}
        </Stack>
      )
    )}</Loaded>
  );
}

function History() {
  const state = useCall("getHistory");
  return (
    <Loaded state={state}>{rows => (
      !rows.length ? <Text>No level or eligibility changes yet.</Text> : (
        <DynamicTable
          head={{ cells: ["When (UTC)", "Agent", "Shape", "Change", "Because"].map(c => ({ key: c, content: c })) }}
          rows={rows.map((r, i) => ({ key: String(i), cells: [
            { key: "When (UTC)", content: when(r.at) },
            { key: "Agent", content: r.agent ?? r.agentId },
            { key: "Shape", content: r.shapeId },
            { key: "Change", content: r.after?.effective != null
              ? `L${r.before?.effective ?? "?"} → L${r.after.effective}${r.after.blocked ? " (blocked)" : ""}` : "context" },
            { key: "Because", content: r.cause },
          ] }))}
          rowsPerPage={20}
        />
      )
    )}</Loaded>
  );
}

function App() {
  const state = useCall("getBoard");
  return (
    <Loaded state={state}>{data => (
      <Stack space="space.200">
        {data.importedNote ? <SectionMessage appearance="discovery" title="Imported history"><Text>{data.importedNote}</Text></SectionMessage> : null}
        <ModeBanner mode={data.mode} windowNote={data.windowNote} />
        <Tabs id="lessel-tabs">
          <TabList><Tab>Agents × shapes</Tab><Tab>Clean Room</Tab><Tab>History</Tab></TabList>
          <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}>{data.agents.length ? <Grid data={data} onChanged={state.retry} /> : <Text>No agents yet. Add them in Lessel settings.</Text>}</Box></TabPanel>
          <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}><CleanRoom /></Box></TabPanel>
          <TabPanel><Box xcss={xcss({ paddingTop: "space.200" })}><History /></Box></TabPanel>
        </Tabs>
      </Stack>
    )}</Loaded>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
