import { db } from "../db";
import { SEVERITY_WEIGHTS } from "../../shared/rule-catalog";
import { Severity } from "../../shared/types";

/** SQL expression (alias `f` = findings) yielding the id of the ignore rule that suppresses a finding, or NULL. */
export const IGNORE_RULE_ID_SQL = `(SELECT ir.id FROM ignore_rules ir
  WHERE ir.site_id = f.site_id AND (
    (ir.scope = 'rule' AND ir.rule_id = f.rule_id) OR
    (ir.scope = 'item' AND ir.subject_id = f.subject_id) OR
    (ir.scope = 'finding' AND ir.subject_id = f.subject_id AND ir.rule_id = f.rule_id)
  ) ORDER BY ir.id LIMIT 1)`;

export interface ScoreCounts {
  critical: number;
  warning: number;
  info: number;
}

export function subjectScore(severities: Severity[]): number {
  const deduction = severities.reduce((sum, s) => sum + SEVERITY_WEIGHTS[s], 0);
  return Math.max(0, 100 - deduction);
}

export interface SiteScore extends ScoreCounts {
  score: number;
  subjectsTotal: number;
}

/** Site score = mean of per-subject scores (pages, CMS items, plus one "site" subject). Ignored / resolved findings do not count. */
export function computeSiteScore(siteId: string): SiteScore {
  const rows = db
    .prepare(
      `SELECT f.subject_type, f.subject_id, f.severity FROM findings f
       WHERE f.site_id = ? AND f.status = 'open' AND ${IGNORE_RULE_ID_SQL} IS NULL`
    )
    .all(siteId) as Array<{ subject_type: string; subject_id: string; severity: Severity }>;

  const bySubject = new Map<string, Severity[]>();
  const counts: ScoreCounts = { critical: 0, warning: 0, info: 0 };
  for (const r of rows) {
    counts[r.severity] += 1;
    const key = `${r.subject_type}:${r.subject_id}`;
    const arr = bySubject.get(key) ?? [];
    arr.push(r.severity);
    bySubject.set(key, arr);
  }

  const known = (db.prepare(`SELECT COUNT(*) AS n FROM audit_subjects WHERE site_id = ?`).get(siteId) as { n: number }).n;
  const total = Math.max(known + 1, bySubject.size, 1);
  let sum = 0;
  bySubject.forEach((sevs) => {
    sum += subjectScore(sevs);
  });
  sum += 100 * (total - bySubject.size);
  const score = Math.round((sum / total) * 10) / 10;
  return { score, subjectsTotal: total, ...counts };
}

/** Recomputes score/counts of the latest completed run after findings changed (ignore, resolve, fix, incremental). */
export function rescoreLatestRun(siteId: string): SiteScore {
  const s = computeSiteScore(siteId);
  const latest = db
    .prepare(`SELECT id FROM audit_runs WHERE site_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1`)
    .get(siteId) as { id: number } | undefined;
  if (latest) {
    db.prepare(
      `UPDATE audit_runs SET site_score = ?, subjects_total = ?, critical_count = ?, warning_count = ?, info_count = ? WHERE id = ?`
    ).run(s.score, s.subjectsTotal, s.critical, s.warning, s.info, latest.id);
  }
  return s;
}
