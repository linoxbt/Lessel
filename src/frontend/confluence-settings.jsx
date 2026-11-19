import React, { useState } from "react";
import ForgeReconciler, {
  Button, Heading, Inline, Label, Lozenge, SectionMessage, Stack, Text, Textfield,
} from "@forge/react";
import { ErrorMessage, Loaded, call, useCall, when } from "./shared";

// Confluence global settings page, rendered in Lessel's Confluence installation. Lessel's data lives in its Jira
// installation; this page links the two with a pairing code created in Jira (Apps → Lessel settings → Links).

function App() {
  const state = useCall("confluenceLinkStatus");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const pair = async () => {
    setBusy(true);
    const r = await call("pairConfluence", { code: code.trim() });
    setBusy(false);
    if (r.error) { setError(r.error); setDone(false); return; }
    setError(null);
    setCode("");
    setDone(true);
    state.setData(r.data);
  };
  return (
    <Stack space="space.200">
      <Heading as="h2">Lessel</Heading>
      <Text>Lessel keeps its data in its Jira installation. Linking this Confluence site lets the Clean Room see page versions, scan them, and quarantine poisoned pages.</Text>
      <Loaded state={state}>{st => (
        <Inline space="space.100" alignBlock="center">
          <Text>Status:</Text>
          <Lozenge appearance={st?.linked ? "success" : "default"} isBold>{st?.linked ? "linked" : "not linked"}</Lozenge>
          {st?.linked && st.linkedAt ? <Text>since {when(st.linkedAt)}</Text> : null}
        </Inline>
      )}</Loaded>
      {done ? <SectionMessage appearance="success"><Text>Linked. Confluence events now reach Lessel.</Text></SectionMessage> : null}
      <ErrorMessage error={error} />
      <Stack space="space.100">
        <Text>In Jira, open Apps → Lessel settings → Links, click Create pairing code for Confluence, and paste the code here.</Text>
        <Label labelFor="lessel-pairing-code">Pairing code</Label>
        <Inline space="space.100" alignBlock="center">
          <Textfield id="lessel-pairing-code" value={code} onChange={e => { setCode(e.target.value); setError(null); }} placeholder="Pairing code from Jira" />
          <Button appearance="primary" isDisabled={busy || !code.trim()} onClick={pair}>{busy ? "Linking…" : state.data?.linked ? "Link again" : "Link"}</Button>
        </Inline>
      </Stack>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
