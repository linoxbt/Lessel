"use strict";
// Provisional, final and frozen shapes (spec §9.4).

const repo = require("../db/repo");
const { ports } = require("../ports");
const S = require("../core/shape");

function rulesFrom(cfg) {
  return { servicePaths: cfg.servicePaths, classPaths: cfg.classPaths };
}

/** Shape object used by decide(): { shape_id, service, change_class, critical, classified_by, fallback }. */
function shapeObj(shapeId, classifiedBy, cfg, fallback = false) {
  const [service, change_class] = String(shapeId).split("/");
  return { shape_id: shapeId, service, change_class, critical: cfg.criticalServices.includes(service) ? 1 : 0,
    classified_by: classifiedBy, fallback };
}

async function remember(shapeId, cfg) {
  const s = shapeObj(shapeId, "path", cfg);
  await repo.upsertShape({ shape_id: shapeId, service: s.service, change_class: s.change_class, critical: s.critical });
}

/** Provisional shape at assignment: LLM on ticket text, Compass/first component or repo default for the service. */
async function provisionalShape({ summary, description, components = [] }, cfg) {
  const componentService = components.map(c => c?.name).find(n => cfg.servicePaths.some(r => r.service === n));
  const service = componentService ?? Object.values(cfg.repos)[0]?.defaultService ?? cfg.servicePaths[0]?.service ?? "default";
  const { change_class } = await ports.llm.classifyClass({ summary, description, paths: [] });
  const shape_id = S.shapeId(service, change_class);
  await remember(shape_id, cfg);
  return { shape_id, classified_by: "llm" };
}

/** Final shape for a PR from its changed paths; LLM only when the path map has no answer. Event handlers only. */
async function finalShapeForPaths({ paths, summary, description, repoDefaultService }, cfg) {
  const rules = rulesFrom(cfg);
  const service = S.serviceForPaths(paths, { servicePaths: cfg.servicePaths, criticalServices: cfg.criticalServices,
    fallback: repoDefaultService ?? cfg.servicePaths[0]?.service ?? "default" });
  let cls = S.classFromPaths(paths, rules);
  let classified_by = "path";
  if (!cls) {
    cls = (await ports.llm.classifyClass({ summary, description, paths: paths.slice(0, 200) })).change_class;
    classified_by = "llm";
  }
  const shape_id = S.shapeId(service, cls);
  await remember(shape_id, cfg);
  return { shape_id, classified_by };
}

/**
 * Shape for the merge check: stored final shape if computed for this head, else path-only,
 * else the item's provisional shape. Never calls the LLM. Fallbacks disable self-merge.
 */
async function shapeForGate(pr, prRow, item, cfg) {
  const head = pr.source?.commit?.hash;
  if (prRow?.shape_id && prRow.shape_head && head && prRow.shape_head.startsWith(head.slice(0, 12)))
    return shapeObj(prRow.shape_id, prRow.classified_by, cfg);
  try {
    const { paths } = await ports.bitbucket.prDiffstat(pr.destination?.repository?.workspace?.uuid ?? prRow?.workspace_uuid,
      pr.destination?.repository?.uuid ?? prRow?.repo_uuid, pr.id);
    const cls = S.classFromPaths(paths, rulesFrom(cfg));
    if (cls) {
      const service = S.serviceForPaths(paths, { servicePaths: cfg.servicePaths, criticalServices: cfg.criticalServices,
        fallback: item.shape_id.split("/")[0] });
      return shapeObj(S.shapeId(service, cls), "path", cfg, true);
    }
  } catch (e) {
    console.warn("diffstat failed in gate", e?.message);
  }
  return shapeObj(prRow?.shape_id ?? item.shape_id, prRow?.classified_by ?? item.classified_by, cfg, true);
}

module.exports = { shapeObj, provisionalShape, finalShapeForPaths, shapeForGate, rulesFrom };
