import { NextFunction, Request, Response, Router } from "express";
import { db } from "../db";
import { RULE_CATALOG, ruleTitle } from "../../shared/rule-catalog";
import { AuditRunDTO, FindingDTO, IgnoreScope, Severity } from "../../shared/types";
import { isAuditRunning, startFullAudit } from "../services/auditor";
import { applyFix, FixError } from "../services/fixes";
import { IGNORE_RULE_ID_SQL, rescoreLatestRun, subjectScore } from "../services/scoring";

const router = Router();

function siteOf(req: Request): string {
  return String(req.params.siteId);
}

function requireInstall(req: Request, res: Response, next: NextFunction): void {
  const ok = db.prepare(`SELECT 1 FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`).get(siteOf(req));
  if (!ok) {
    res.status(404).json({ error: "Site is not installed" });
    return;
  }
  next();
}

router.use("/sites/:siteId", requireInstall);

interface RunRow {
  id: number; kind: string; trigger_source: string; status: string; started_at: string; finished_at: string | null;
  site_score: number | null; pages_scanned: number; items_scanned: number;
  critical_count: number; warning_count: number; info_count: number; error: string | null;
}

function runDto(r: RunRow): AuditRunDTO {
  return {
    id: r.id, kind: r.kind, triggerSource: r.trigger_source, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    siteScore: r.site_score, pagesScanned: r.pages_scanned, itemsScanned: r.items_scanned,
    critical: r.critical_count, warning: r.warning_count, info: r.info_count, error: r.error,
  };
}

interface FindingRow {
  id: string; run_id: number; subject_type: FindingDTO["subjectType"]; subject_id: string; subject_label: string;
  collection_id: string | null; rule_id: string; severity: Severity; message: string; current_value: string | null;
  suggested_value: string | null; fix_kind: FindingDTO["fixKind"]; fix_field: string | null; fix_patch: string | null;
  manual_steps: string | null; element_id: string | null; status: "open" | "resolved"; ignore_rule_id: number | null;
}

function findingDto(r: FindingRow): FindingDTO {
  let canOverride = false;
  if (r.fix_kind === "api_patch" && r.fix_patch && r.fix_field) {
    try {
      canOverride = typeof (JSON.parse(r.fix_patch) as Record<string, unknown>)[r.fix_field] === "string";
    } catch {
      canOverride = false;
    }
  }
  return {
    id: r.id, runId: r.run_id, subjectType: r.subject_type, subjectId: r.subject_id, subjectLabel: r.subject_label,
    collectionId: r.collection_id, ruleId: r.rule_id, ruleTitle: ruleTitle(r.rule_id), severity: r.severity, message: r.message,
    currentValue: r.current_value, suggestedValue: r.suggested_value, fixKind: r.fix_kind, fixField: r.fix_field,
    canOverrideValue: canOverride, manualSteps: r.manual_steps, elementId: r.element_id, status: r.status, ignoreRuleId: r.ignore_rule_id,
  };
}

router.get("/rules", (_req, res) => {
  res.json({ rules: Object.entries(RULE_CATALOG).map(([id, info]) => ({ id, ...info })) });
});

// ---- audit runs ----

router.post("/sites/:siteId/runs", (req, res) => {
  const runId = startFullAudit(siteOf(req), "manual");
  if (runId === null) {
    res.status(409).json({ error: "An audit is already running for this site" });
    return;
  }
  res.status(202).json({ runId });
});

router.get("/sites/:siteId/runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const rows = db
    .prepare(`SELECT * FROM audit_runs WHERE site_id = ? ORDER BY id DESC LIMIT ?`)
    .all(siteOf(req), limit) as RunRow[];
  res.json({ runs: rows.reverse().map(runDto) });
});

router.get("/sites/:siteId/runs/:runId", (req, res) => {
  const row = db.prepare(`SELECT * FROM audit_runs WHERE site_id = ? AND id = ?`).get(siteOf(req), Number(req.params.runId)) as RunRow | undefined;
  if (!row) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({ run: runDto(row) });
});

router.get("/sites/:siteId/summary", (req, res) => {
  const siteId = siteOf(req);
  const completed = db
    .prepare(`SELECT * FROM audit_runs WHERE site_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 2`)
    .all(siteId) as RunRow[];
  const inFlight = db
    .prepare(`SELECT * FROM audit_runs WHERE site_id = ? AND status = 'running' AND kind = 'full' ORDER BY id DESC LIMIT 1`)
    .get(siteId) as RunRow | undefined;
  const last = db.prepare(`SELECT * FROM audit_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1`).get(siteId) as RunRow | undefined;
  const settings = db.prepare(`SELECT thin_content_words FROM installations WHERE site_id = ?`).get(siteId) as { thin_content_words: number };
  res.json({
    latest: completed[0] ? runDto(completed[0]) : null,
    previousScore: completed[1]?.site_score ?? null,
    running: isAuditRunning(siteId),
    runningRunId: inFlight?.id ?? null,
    lastFailure: last && last.status === "failed" ? last.error : null,
    settings: { thinContentWords: settings.thin_content_words },
  });
});

// ---- findings ----

router.get("/sites/:siteId/findings", (req, res) => {
  const tab = String(req.query.tab || "open");
  const where =
    tab === "ignored" ? `ignore_rule_id IS NOT NULL AND status = 'open'`
    : tab === "resolved" ? `status = 'resolved'`
    : `ignore_rule_id IS NULL AND status = 'open'`;
  const rows = db
    .prepare(
      `SELECT * FROM (SELECT f.*, ${IGNORE_RULE_ID_SQL} AS ignore_rule_id FROM findings f WHERE f.site_id = ?) WHERE ${where}
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, subject_label, rule_id`
    )
    .all(siteOf(req)) as FindingRow[];
  const findings = rows.map(findingDto);

  // Per-subject scores are computed over open, non-ignored findings only.
  const activeRows = db
    .prepare(`SELECT f.subject_type, f.subject_id, f.severity FROM findings f WHERE f.site_id = ? AND f.status = 'open' AND ${IGNORE_RULE_ID_SQL} IS NULL`)
    .all(siteOf(req)) as Array<{ subject_type: string; subject_id: string; severity: Severity }>;
  const sevBySubject = new Map<string, Severity[]>();
  for (const r of activeRows) {
    const arr = sevBySubject.get(r.subject_id) ?? [];
    arr.push(r.severity);
    sevBySubject.set(r.subject_id, arr);
  }
  const subjects: Record<string, { score: number }> = {};
  for (const f of findings) subjects[f.subjectId] = { score: subjectScore(sevBySubject.get(f.subjectId) ?? []) };

  res.json({ findings, subjects });
});

router.post("/sites/:siteId/findings/:id/apply-fix", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { value?: unknown; publish?: unknown };
    await applyFix(siteOf(req), String(req.params.id), {
      value: typeof body.value === "string" ? body.value : undefined,
      publish: body.publish === true,
    });
    res.json({ ok: true, summary: latestSummary(siteOf(req)) });
  } catch (err) {
    if (err instanceof FixError) res.status(err.status).json({ error: err.message });
    else res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function setStatus(siteId: string, id: string, status: "open" | "resolved"): boolean {
  const r = db
    .prepare(`UPDATE findings SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END WHERE id = ? AND site_id = ?`)
    .run(status, status, id, siteId);
  if (r.changes) rescoreLatestRun(siteId);
  return r.changes > 0;
}

router.post("/sites/:siteId/findings/:id/resolve", (req, res) => {
  if (!setStatus(siteOf(req), String(req.params.id), "resolved")) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.json({ ok: true, summary: latestSummary(siteOf(req)) });
});

router.post("/sites/:siteId/findings/:id/reopen", (req, res) => {
  if (!setStatus(siteOf(req), String(req.params.id), "open")) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.json({ ok: true, summary: latestSummary(siteOf(req)) });
});

function latestSummary(siteId: string): AuditRunDTO | null {
  const row = db.prepare(`SELECT * FROM audit_runs WHERE site_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1`).get(siteId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

// ---- ignore rules ----

router.get("/sites/:siteId/ignore-rules", (req, res) => {
  const rows = db.prepare(`SELECT * FROM ignore_rules WHERE site_id = ? ORDER BY id DESC`).all(siteOf(req)) as Array<{
    id: number; scope: IgnoreScope; rule_id: string | null; subject_id: string | null; subject_label: string | null; created_at: string;
  }>;
  res.json({
    rules: rows.map((r) => ({
      id: r.id, scope: r.scope, ruleId: r.rule_id, ruleTitle: r.rule_id ? ruleTitle(r.rule_id) : null,
      subjectId: r.subject_id, subjectLabel: r.subject_label, createdAt: r.created_at,
    })),
  });
});

router.post("/sites/:siteId/ignore-rules", (req, res) => {
  const siteId = siteOf(req);
  const body = (req.body ?? {}) as { scope?: string; ruleId?: string; subjectId?: string; subjectLabel?: string };
  const scope = body.scope as IgnoreScope;
  const needsRule = scope === "rule" || scope === "finding";
  const needsSubject = scope === "item" || scope === "finding";
  if (!["rule", "item", "finding"].includes(scope) || (needsRule && !body.ruleId) || (needsSubject && !body.subjectId)) {
    res.status(400).json({ error: "scope must be rule|item|finding with the matching ruleId / subjectId" });
    return;
  }
  const ruleId = needsRule ? body.ruleId! : null;
  const subjectId = needsSubject ? body.subjectId! : null;
  const existing = db
    .prepare(`SELECT id FROM ignore_rules WHERE site_id = ? AND scope = ? AND IFNULL(rule_id,'') = ? AND IFNULL(subject_id,'') = ?`)
    .get(siteId, scope, ruleId ?? "", subjectId ?? "") as { id: number } | undefined;
  let id = existing?.id;
  if (!id) {
    const r = db
      .prepare(`INSERT INTO ignore_rules (site_id, scope, rule_id, subject_id, subject_label, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
      .run(siteId, scope, ruleId, subjectId, body.subjectLabel ?? null);
    id = Number(r.lastInsertRowid);
  }
  const summary = rescoreLatestRun(siteId);
  res.status(201).json({ id, score: summary.score });
});

router.delete("/sites/:siteId/ignore-rules/:id", (req, res) => {
  const siteId = siteOf(req);
  const r = db.prepare(`DELETE FROM ignore_rules WHERE id = ? AND site_id = ?`).run(Number(req.params.id), siteId);
  if (!r.changes) {
    res.status(404).json({ error: "Ignore rule not found" });
    return;
  }
  const summary = rescoreLatestRun(siteId);
  res.json({ ok: true, score: summary.score });
});

// ---- settings ----

router.get("/sites/:siteId/settings", (req, res) => {
  const row = db.prepare(`SELECT thin_content_words FROM installations WHERE site_id = ?`).get(siteOf(req)) as { thin_content_words: number };
  res.json({ thinContentWords: row.thin_content_words });
});

router.put("/sites/:siteId/settings", (req, res) => {
  const words = Number((req.body ?? {}).thinContentWords);
  if (!Number.isFinite(words) || words < 50 || words > 5000) {
    res.status(400).json({ error: "thinContentWords must be between 50 and 5000" });
    return;
  }
  db.prepare(`UPDATE installations SET thin_content_words = ? WHERE site_id = ?`).run(Math.round(words), siteOf(req));
  res.json({ thinContentWords: Math.round(words) });
});

export default router;
