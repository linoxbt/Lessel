import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Box, Button, ButtonGroup, DynamicTable, Heading, Inline, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader,
  ModalTitle, ModalTransition, SectionMessage, Select, Spinner, Stack, Strong, Text, TextArea, useProductContext,
  xcss,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { CAUSALITY_APPEARANCE, ErrorMessage, when } from "./shared";

function Signals({ data, act, onReopen }) {
  if (!data.signals.length) return <Text>No reverts, reopens, incidents or bugs linked to this item.</Text>;
  return (
    <Stack space="space.100">
      {data.signals.map(s => (
        <Box key={s.id} xcss={xcss({ padding: "space.100", borderColor: "color.border", borderWidth: "border.width", borderStyle: "solid", borderRadius: "border.radius" })}>
          <Stack space="space.050">
            <Inline space="space.100" alignBlock="center">
              <Strong>{s.kind} {s.ref}</Strong>
              <Lozenge appearance={CAUSALITY_APPEARANCE[s.causality]}>{s.causality}</Lozenge>
              {s.severity ? <Lozenge>sev {s.severity}</Lozenge> : null}
            </Inline>
            {s.causality === "associated" || s.causality === "suspected" ? (
              <Stack space="space.050">
                <Text>Did this work cause {s.ref}? A link isn't proof; only a confirmed cause changes the record.</Text>
                <ButtonGroup>
                  <Button appearance="danger" isDisabled={!data.canConfirm} onClick={() => act("confirmCause", { signalId: s.id })}>Confirm cause</Button>
                  <Button onClick={() => act("dismissCause", { signalId: s.id })}>Dismiss</Button>
                </ButtonGroup>
              </Stack>
            ) : (
              <Inline space="space.100" alignBlock="center">
                <Text>Decided by {s.decidedBy ?? "—"}{s.via ? ` via ${s.via}` : ""}, {when(s.decidedAt)} (revision {s.rev}).</Text>
                <Button appearance="subtle" spacing="compact" onClick={() => onReopen(s)}>Reopen decision</Button>
              </Inline>
            )}
          </Stack>
        </Box>
      ))}
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

function App() {
  const ctx = useProductContext();
  const issueKey = ctx?.extension?.issue?.key;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reopen, setReopen] = useState(null);
  const [note, setNote] = useState("");
  const [shape, setShape] = useState(null);

  const load = async () => {
    const r = await invoke("getPanel", { issueKey });
    if (r?.error) setError(r.error); else { setError(null); setData(r); }
  };
  const act = async (name, payload) => {
    const r = await invoke(name, payload);
    if (r?.error) setError(r.error); else { setError(null); setData(r); }
  };
  useEffect(() => { if (issueKey) load(); }, [issueKey]);

  if (!data) return error ? <ErrorMessage error={error} /> : <Spinner />;
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

      <Inline space="space.100" alignBlock="center">
        <Text>Shape: <Strong>{data.shapeId}</Strong> ({data.shapeState}, by {data.classifiedBy}). Outcome: <Strong>{data.outcome}</Strong>.</Text>
        {data.classifiedBy === "llm" ? <Button spacing="compact" onClick={() => setShape(data.shapeId)}>Confirm shape</Button> : null}
      </Inline>

      <Heading as="h4">Signals</Heading>
      <Signals data={data} act={act} onReopen={s => { setNote(""); setReopen(s); }} />

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
              <Button appearance="primary" isDisabled={!note.trim()} onClick={async () => { await act("reopenDecision", { signalId: reopen.id, note }); setReopen(null); }}>Reopen</Button>
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
              <Button appearance="primary" onClick={async () => { await act("confirmShape", { issueKey: data.issueKey, shapeId: shape }); setShape(null); }}>Confirm</Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
