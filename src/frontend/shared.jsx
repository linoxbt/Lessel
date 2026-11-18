import React from "react";
import { Lozenge, SectionMessage, Text } from "@forge/react";

export const LEVEL_APPEARANCE = { 3: "success", 2: "new", 1: "moved", 0: "removed" };

export function LevelLozenge({ earned, effective, blocked }) {
  if (blocked) return <Lozenge appearance="removed" isBold>Blocked</Lozenge>;
  const label = effective === earned || effective == null ? `L${earned}` : `L${earned} → L${effective}`;
  return <Lozenge appearance={LEVEL_APPEARANCE[effective ?? earned] ?? "default"} isBold={effective !== earned}>{label}</Lozenge>;
}

export const CAUSALITY_APPEARANCE = { associated: "default", suspected: "moved", confirmed: "removed", dismissed: "success", excused: "new" };

export function ModeBanner({ mode, windowNote }) {
  return (
    <SectionMessage appearance={mode === "enforcing" ? "information" : "warning"}>
      <Text>
        {mode === "enforcing" ? "Enforcing: Lessel's decisions block merges." : "Advisory mode: Lessel explains what it would block, but blocks nothing."}
        {windowNote ? ` ${windowNote}.` : ""}
      </Text>
    </SectionMessage>
  );
}

export function ErrorMessage({ error }) {
  if (!error) return null;
  return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
}

export const pct = x => `${Math.round((x ?? 0) * 100)}%`;
export const when = d => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
