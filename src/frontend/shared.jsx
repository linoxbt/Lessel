import React, { useEffect, useState } from "react";
import { Button, Lozenge, SectionMessage, Spinner, Stack, Text } from "@forge/react";
import { invoke } from "@forge/bridge";

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

/** An error in words, with a Retry button when there's something to retry. */
export function ErrorMessage({ error, onRetry, retryLabel = "Retry" }) {
  if (!error) return null;
  return (
    <SectionMessage appearance="error">
      <Stack space="space.100">
        <Text>{error}</Text>
        {onRetry ? <Button spacing="compact" onClick={onRetry}>{retryLabel}</Button> : null}
      </Stack>
    </SectionMessage>
  );
}

/**
 * Call a resolver and never throw: resolves to { data } or { error }. Resolvers report their own failures as
 * { error }; a call that fails on the way (network, time limit) becomes a plain-words error too.
 */
export async function call(name, payload) {
  try {
    const r = await invoke(name, payload);
    if (r && typeof r === "object" && !Array.isArray(r) && typeof r.error === "string") return { error: r.error };
    return { data: r };
  } catch (e) {
    return { error: `Lessel didn't answer${e?.message ? ` (${e.message})` : ""}. Try again in a moment.` };
  }
}

/**
 * Load a resolver's data: { data, error, loading, retry, setData }. A failed reload keeps the last data, so a
 * screen never goes blank; `retry` calls again.
 */
export function useCall(name, payload, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    call(name, payload).then(r => {
      if (!live) return;
      setState(s => (r.error ? { data: s.data, error: r.error, loading: false } : { data: r.data, error: null, loading: false }));
    });
    return () => { live = false; };
  }, [...deps, attempt]);
  return {
    ...state,
    retry: () => setAttempt(n => n + 1),
    setData: data => setState(s => ({ ...s, data, error: null })),
  };
}

/** Spinner while loading, error + Retry if nothing loaded, otherwise the children (a function of the data). */
export function Loaded({ state, children }) {
  if (state.data == null) {
    if (state.error) return <ErrorMessage error={state.error} onRetry={state.retry} />;
    return <Spinner />;
  }
  return (
    <Stack space="space.100">
      <ErrorMessage error={state.error} onRetry={state.retry} />
      {children(state.data)}
    </Stack>
  );
}

export const pct = x => `${Math.round((x ?? 0) * 100)}%`;

/**
 * A time, always in UTC. The backend sends ISO strings with a Z; a bare "YYYY-MM-DD HH:MM:SS" (a raw DB value)
 * is UTC too, so it's read as UTC rather than in the viewer's zone (and so Safari can parse it).
 */
export function toDate(d) {
  if (d == null || d === "") return null;
  if (d instanceof Date) return d;
  const s = String(d);
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = new Date(norm);
  return Number.isNaN(t.getTime()) ? null : t;
}
export const when = d => {
  const t = toDate(d);
  return t ? t.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
};
/** "5 h", "2 days" for countdowns. */
export const hoursText = h => (h == null ? "" : h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`);

/** Countdown for a suspected signal: it expires as dismissed if nobody decides (spec §10.4). */
export function expiryText(s) {
  if (s.expiresInHours == null) return "Expires if nobody decides once the observation window closes.";
  if (s.expiresInHours <= 0) return "Expires undecided at the next hourly check.";
  return `Expires in ${hoursText(s.expiresInHours)} if nobody decides (${when(s.expiresAt)}).`;
}
