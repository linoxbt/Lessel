import React, { useEffect, useState } from "react";
import ForgeReconciler, { Button, Heading, Inline, Label, SectionMessage, Spinner, Stack, Text, Textfield } from "@forge/react";
import { invoke } from "@forge/bridge";

// Workspace settings → Lessel: pair this workspace with one Lessel site.
function App() {
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn, payload) => {
    setBusy(true); setError(null);
    try { setStatus(await invoke(fn, payload)); setCode(""); } catch (e) { setError(e?.message ?? String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { run("status"); }, []);

  if (!status && !error) return <Spinner label="Loading" />;
  return (
    <Stack space="space.200">
      <Heading as="h2">Lessel</Heading>
      <Text>Lessel for Bitbucket sends this workspace's pull request events and merge checks to one Lessel site, and
        nowhere else. Pair it with a code from Jira: Lessel settings → Links → Bitbucket.</Text>
      {error ? <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage> : null}
      {status?.linked
        ? <SectionMessage appearance="success"><Text>Linked to a Lessel site{status.linkedAt ? ` since ${status.linkedAt.slice(0, 16).replace("T", " ")} UTC` : ""}.</Text></SectionMessage>
        : <SectionMessage appearance="warning"><Text>Not linked yet: no events are sent and the Lessel merge check passes without a decision.</Text></SectionMessage>}
      <Stack space="space.050">
        <Label labelFor="code">Pairing code</Label>
        <Textfield id="code" value={code} onChange={e => setCode(e.target.value)} placeholder="lessel1.…" />
      </Stack>
      <Inline space="space.100">
        <Button appearance="primary" isDisabled={busy || !code.trim()} onClick={() => run("pair", { code })}>Pair</Button>
        {status?.linked ? <Button isDisabled={busy} onClick={() => run("unlink")}>Unlink</Button> : null}
      </Inline>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><App /></React.StrictMode>);
