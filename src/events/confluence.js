"use strict";
// Confluence events → Clean Room scan (spec §13.1). Payload fields [verify].

const repo = require("../db/repo");
const { ports } = require("../ports");
const { once } = require("./once");
const { scanConfluencePage, scanJiraText } = require("../services/cleanroom");
const { scan, isSuspect } = require("../core/taint");

async function onConfluenceEvent(event) {
  const cfg = await repo.getSettings();
  const content = event.content ?? event.page ?? {};
  const id = content.id;
  const version = content.version?.number ?? null;
  if (!id) return null;
  if (event.eventType === "avi:confluence:created:comment" || event.eventType === "avi:confluence:updated:comment") {
    const pageId = content.container?.id ?? content.ancestors?.[0]?.id;
    const body = content.body?.storage?.value ?? "";
    const findings = scan(body, { allowedDomains: cfg.cleanRoom.allowedDomains });
    if (pageId && isSuspect(findings)) {
      // Keyed by comment version: a comment edited after it was posted is scanned again.
      return once(`cf:comment:${id}:${version ?? event.eventType.split(":")[2]}`, async () => {
        const src = await repo.upsertSource({ source_id: `confluence:page:${pageId}`, url: `confluence:${pageId}`, title: null });
        for (const f of findings) await repo.addFinding({ source_id: src.source_id, version: 0, ...f });
        if (src.state === "unscanned" || src.state === "clean") await repo.patchSource(src.source_id, { state: "suspect", rationale: "comment: " + [...new Set(findings.map(f => f.filter))].join(", ") });
      });
    }
    return null;
  }
  // Without a version in the payload, key on the page's current version; a fixed key would skip every later edit.
  const v = version ?? (await ports.confluence.getPage(id, null).catch(() => null))?.version?.number ?? null;
  if (v == null) return scanConfluencePage(id, null, cfg);   // idempotent; just not deduped
  return once(`cf:page:${id}:${v}`, () => scanConfluencePage(id, v, cfg));
}

module.exports = { onConfluenceEvent, scanJiraText };
