"use strict";
// Deterministic taint filters (spec §13.1). Input: Confluence storage format or plain text.

const ZERO_WIDTH = /[​-‍⁠﻿]/;

const AI_ADDRESSED = [
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|messages|rules)/i,
  /\bas an? (?:ai|llm|language model|assistant|coding agent|agent)\b[^.\n]{0,60}\b(?:must|should|need to|always|never)\b/i,
  /\b(?:ai|llm|coding|autonomous) agents?\b[^.\n]{0,60}\b(?:must|should|always|never)\b/i,
  /\b(?:system prompt|developer message)\b/i,
];

const DISABLE_CHECKS = [
  /\b(?:disable|turn off|bypass|skip|remove|comment out)\b[^.\n]{0,40}\b(?:checks?|rate[ _-]?limit(?:s|ing)?|auth(?:entication|orization)?|logging|audit|validation|tests?|alerts?)\b/i,
  /\b(?:rate[ _-]?limits?|max_rps|rps|max_requests)\b[^.\n]{0,30}\b(?:to|=|:)\s*0\b/i,
];

// "Don't forget to…", "never hesitate to…" are instructions, not negations.
const NOT_REALLY = String.raw`(?!\s+(?:forget|hesitate|fail|miss)\b)`;
const NEGATED = new RegExp(String.raw`\b(?:never(?! ?mind)${NOT_REALLY}|don'?t${NOT_REALLY}|do not${NOT_REALLY}|must not|mustn'?t|should not|shouldn'?t|cannot|can'?t|avoid|no one should)\b`, "i");

const HIDING = String.raw`(?:color\s*:\s*(?:#fff(?:fff)?\b|white|rgba?\([^)]*,\s*0\))|font-size\s*:\s*0(?:px|pt|em)?\b|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\b)`;
// Either quote style: style="…" or style='…'.
const HIDDEN_STYLE = new RegExp(String.raw`style\s*=\s*(?:"[^"]*${HIDING}[^"]*"|'[^']*${HIDING}[^']*')`, "i");
const BASE64 = /[A-Za-z0-9+/]{200,}={0,2}/;
const URL = /\bhttps?:\/\/([a-z0-9.-]+)/gi;

// Inline tags join words ("dis<b></b>able"); block tags and breaks separate them.
const stripTags = s => s.replace(/<\/?(?:p|div|br|li|ul|ol|tr|td|th|h[1-6]|table|blockquote|pre)\b[^>]*>/gi, " ")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

function quoteAround(text, index, len) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + len + 120);
  return stripTags(text.slice(start, end)).slice(0, 400);
}

function hostAllowed(host, allowed) {
  host = host.toLowerCase();
  return allowed.some(d => host === d || host.endsWith(`.${d}`));
}

/**
 * Scan one body. Returns findings: { filter, offset, quote }.
 * Hidden elements are scanned with their content, so the quote shows the hidden text itself.
 */
function scan(body, { allowedDomains = [] } = {}) {
  const text = String(body || "");
  const findings = [];
  const add = (filter, index, len) => findings.push({ filter, offset: index, quote: quoteAround(text, index, len) });

  // HTML comments and hidden-styled elements
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) add("hidden", m.index, m[0].length);
  for (const m of text.matchAll(new RegExp(`<([a-z0-9:]+)[^>]*${HIDDEN_STYLE.source}[^>]*>([\\s\\S]*?)</\\1>`, "gi")))
    add("hidden", m.index, m[0].length);
  const zw = text.search(ZERO_WIDTH);
  if (zw !== -1) add("hidden", zw, 1);

  // Instruction filters read the text a person (or an agent) sees, so markup can't split a phrase apart
  // ("dis<b></b>able the checks"). Offsets of these findings point into that plain text.
  const plain = stripTags(text);
  const addPlain = (filter, m) => findings.push({ filter, offset: m.index, quote: plain.slice(Math.max(0, m.index - 80), m.index + m[0].length + 120).slice(0, 400) });
  for (const re of AI_ADDRESSED) { const m = plain.match(re); if (m) { addPlain("ai-addressed", m); break; } }
  // A negated instruction ("Never set max_rps to 0", "Do not skip the tests") is a safety rule, not an attack.
  const live = DISABLE_CHECKS.flatMap(re => [...plain.matchAll(new RegExp(re.source, "gi"))]).find(m => !NEGATED.test(
    plain.slice(Math.max(0, m.index - 40), m.index).split(/[.!?:;\n]/).pop()));
  if (live) addPlain("disable-checks", live);
  const b64 = plain.match(BASE64); if (b64) addPlain("base64", b64);

  for (const m of text.matchAll(URL)) if (!hostAllowed(m[1], allowedDomains)) add("link", m.index, m[0].length);

  // one finding per (filter, offset)
  const seen = new Set();
  return findings.filter(f => { const k = `${f.filter}:${f.offset}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Content filters that make a source suspect (links alone are reported but don't by themselves). */
const isSuspect = findings => findings.some(f => f.filter !== "link") ||
  findings.filter(f => f.filter === "link").length >= 3;

module.exports = { scan, isSuspect, stripTags };
