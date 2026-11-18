"use strict";
// Confluence events → Clean Room scan (spec §13.1). Payload fields [verify].

const repo = require("../db/repo");
const { once } = require("./once");
const { scanConfluencePage, scanJiraText } = require("../services/cleanroom");
const { scan, isSuspect } = require("../core/taint");

async function onConfluenceEvent(event) {
  const cfg = await repo.getSettings();
  const content = event.content ?? event.page ?? {};
  const id = content.id;
  const version = content.version?.number ?? null;
  if (!id) return null;
  if (event.eventType === "avi:confluence:created:comment") {
    const pageId = content.container?.id ?? content.ancestors?.[0]?.id;
    const body = content.body?.storage?.value ?? "";
    const findings = scan(body, { allowedDomains: cfg.cleanRoom.allowedDomains });
    if (pageId && isSuspect(findings)) {
      return once(`cf:comment:${id}`, async () => {
        const src = await repo.upsertSource({ source_id: `confluence:page:${pageId}`, url: `confluence:${pageId}`, title: null });
        for (const f of findings) await repo.addFinding({ source_id: src.source_id, version: 0, ...f });
        if (src.state === "unscanned" || src.state === "clean") await repo.patchSource(src.source_id, { state: "suspect", rationale: "comment: " + [...new Set(findings.map(f => f.filter))].join(", ") });
      });
    }
    return null;
  }
  return once(`cf:page:${id}:${version ?? "current"}`, () => scanConfluencePage(id, version, cfg));
}

module.exports = { onConfluenceEvent, scanJiraText };
