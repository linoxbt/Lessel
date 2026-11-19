import React, { useState } from "react";
import ForgeReconciler, {
  Box, Button, ButtonGroup, DynamicTable, Heading, Inline, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader,
  ModalTitle, ModalTransition, SectionMessage, Select, Spinner, Stack, Strong, Text, TextArea, useProductContext,
  xcss,
} from "@forge/react";
import { CAUSALITY_APPEARANCE, ErrorMessage, Loaded, call, expiryText, useCall, when } from "./shared";

function Signals({ data, act, busy, onReopen }) {
  if (!data.signals.length) return <Text>No reverts, reopens, incidents or bugs linked to this item.</Text>;
  return (
    <Stack space="space.100">
      {data.signals.map(s => (
        <Box key={s.id} xcss={xcss({ padding: "space.100", borderColor: "color.border", borderWidth: "border.width", borderStyle: "solid", borderRadius: "border.radius" })}>
          <Stack space="space.050">
            <Inline space="space.100" alignBlock="center">
              <Strong>{s.kind} {s.ref}</Strong>
              <Lozenge appearance={CAUSALITY_APPEARANCE[s.causality]}>{s.expired ? "expired, nobody decided" : s.causality}</Lozenge>
              {s.severity ? <Lozenge>sev {s.severity}</Lozenge> : null}
              {s.causality === "confirmed" && data.possibleBadInput ? <Lozenge appearance="moved">possible bad input</Lozenge> : null}
            </Inline>
            {s.causality === "associated" || s.causality === "suspected" ? (
              <Stack space="space.050">
                <Text>Did this work cause {s.ref}? A link isn't proof; only a confirmed cause changes the record.</Text>
                {s.causality === "suspected" ? <Text>{expiryText(s)}</Text> : null}
                <ButtonGroup>
                  <Button appearance="danger" isDisabled={busy || !data.canConfirm} onClick={() => act("confirmCause", { signalId: s.id })}>Confirm cause</Button>
                  <Button isDisabled={busy} onClick={() => act("dismissCause", { signalId: s.id })}>Dismiss</Button>
                </ButtonGroup>
                {!data.canConfirm ? <Text>Too late to confirm: causes can only be confirmed for a while after deployment.</Text> : null}
              </Stack>
            ) : (
              <Inline space="space.100" alignBlock="center">
                <Text>
                  {s.expired ? `Expired undecided, ${when(s.decidedAt)}` : `Decided by ${s.decidedBy ?? "—"}${s.via ? ` via ${s.via}` : ""}, ${when(s.decidedAt)}`} (revision {s.rev}).
                </Text>
                <Button appearance="subtle" spacing="compact" isDisabled={busy} onClick={() => onReopen(s)}>Reopen decision</Button>
              </Inline>
            )}
          </Stack>
        </Box>
      ))}
      {data.possibleBadInput ? (
        <SectionMessage appearance="warning" title="Possible bad input">
          <Text>This item read a source inside a tainted range, but the read can't excuse the failure automatically (it was inferred, flagged or declared after merge). A person should decide whether the failure came from bad input.</Text>
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

function Reads({ reads }) {
  if (!reads.length) return <Text>No context declared for this item.</Text>;
  return (
    <DynamicTable
      head={{ cells: [{ key: "s", content: "Source" }, { key: "v", content: "Version" }, { key: "b", content: "Basis" }, { key: "st", content: "State" }] }}
      rows={reads.map((r, i) => ({ key: String(i), cells: [
        { key: "s", content: r.title },
        { key: "v", content: r.version != null ? `v${r.version}` : "?" },
        { key: "b", content: `${r.basis}${r.flag ? ` (${r.flag})` : ""}${r.late ? ", declared after merge" : ""}` },
        { key: "st", content: `${r.sourceState}${r.range ? `, tainted ${r.range}` : ""}` },
      ] }))}
    />
  );
}

function Panel({ data, act, busy, error }) {
  const [reopen, setReopen] = useState(null);
  const [note, setNote] = useState("");
  const [shape, setShape] = useState(null);
  if (!data.tracked) return <Text>Lessel tracks this item once it's assigned to an agent or has a linked PR.</Text>;
  return (
    <Stack space="space.200">
      <ErrorMessage error={error} />
      {data.decision ? (
        <SectionMessage appearance={data.decision.blocked ? "error" : data.decision.approvals >= 2 ? "warning" : "success"}
          title={data.mode === "enforcing" ? "Lessel decision" : "Lessel decision (advisory)"}>
          <Text>{data.decision.sentence}</Text>
        </SectionMessage>
      ) : <Text>Team item: people are never scored individually.</Text>}

      {data.recommendation ? <SectionMessage appearance="discovery"><Text>{data.recommendation}</Text></SectionMessage> : null}
      <Inline space="space.100" alignBlock="center">
        <Text>Shape: <Strong>{data.shapeId}</Strong> ({data.shapeState}, by {data.classifiedBy}). Outcome: <Strong>{data.outcome}</Strong>.</Text>
        {data.classifiedBy === "llm" ? <Button spacing="compact" isDisabled={busy} onClick={() => setShape(data.shapeId)}>Confirm shape</Button> : null}
      </Inline>
      {data.windowEnds ? <Text>Observation window: {when(data.windowStart)} → {when(data.windowEnds)}{data.windowNote ? ` (${data.windowNote})` : ""}.</Text> : null}

      <Heading as="h4">Signals</Heading>
      <Signals data={data} act={act} busy={busy} onReopen={s => { setNote(""); setReopen(s); }} />

      <Heading as="h4">Teamwork Graph</Heading>
      <Text>
        {data.devChain && !data.devChain.error
          ? `${data.devChain.commits} commit(s), ${data.devChain.prs} pull request(s), ${data.devChain.deployments} deployment(s) linked to this work item.`
          : data.graph?.skipped ?? (data.graph?.error || data.devChain?.error ? `Graph unavailable (${data.graph?.error ?? data.devChain?.error}).` : "No graph data yet.")}
        {data.graph?.added?.length ? ` New incident links found in the graph: ${data.graph.added.join(", ")} (associated, not confirmed).` : ""}
      </Text>

      <Heading as="h4">Context</Heading>
      {data.context.state !== "clean" ? <SectionMessage appearance={data.context.state === "blocked" ? "error" : "warning"}><Text>{data.context.reason}</Text></SectionMessage> : null}
      <Reads reads={data.reads} />
      <Text>Declarations are the agent's own attestations, not proof.</Text>

      <ModalTransition>
        {reopen ? (
          <Modal onClose={() => setReopen(null)}>
            <ModalHeader><ModalTitle>Reopen decision on {reopen.ref}</ModalTitle></ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>This puts the signal back to "associated" and recomputes the record. Admins only; the note is audited.</Text>
                <TextArea value={note} onChange={e => setNote(e.target.value)} placeholder="Why are you reopening this?" />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button onClick={() => setReopen(null)}>Cancel</Button>
              <Button appearance="primary" isDisabled={busy || !note.trim()} onClick={async () => { await act("reopenDecision", { signalId: reopen.id, note }); setReopen(null); }}>Reopen</Button>
            </ModalFooter>
          </Modal>
        ) : null}
        {shape ? (
          <Modal onClose={() => setShape(null)}>
            <ModalHeader><ModalTitle>Confirm shape for {data.issueKey}</ModalTitle></ModalHeader>
            <ModalBody>
              <Select options={data.shapeOptions.map(s => ({ label: s, value: s }))} defaultValue={{ label: shape, value: shape }}
                onChange={o => setShape(o.value)} />
            </ModalBody>
            <ModalFooter>
              <Button onClick={() => setShape(null)}>Cancel</Button>
              <Button appearance="primary" isDisabled={busy} onClick={async () => { await act("confirmShape", { issueKey: data.issueKey, shapeId: shape }); setShape(null); }}>Confirm</Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

function Loader({ issueKey }) {
  const state = useCall("getPanel", { issueKey }, [issueKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const act = async (name, payload) => {
    setBusy(true);
    const r = await call(name, payload);
    setBusy(false);
    if (r.error) { setError(r.error); return false; }
    setError(null);
    state.setData(r.data);
    return true;
  };
  return <Loaded state={state}>{data => <Panel data={data} act={act} busy={busy} error={error} />}</Loaded>;
}

function App() {
  const ctx = useProductContext();
  const issueKey = ctx?.extension?.issue?.key;
  if (!issueKey) return <Spinner />;
  return <Loader issueKey={issueKey} />;
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
