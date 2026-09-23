// Audit orchestration: full-site crawl, incremental single-item re-checks, persistence and scheduling.

import { v4 as uuid } from "uuid";
import { db } from "../db";
import { FindingDraft, RuleConfig, SubjectRef, WfCollection, WfItem, WfPage } from "../../shared/types";
import { webflowClient, WebflowApiError } from "./webflow-client";
import { buildPageIndex, DomSummary, runPageRules, summarizeDom } from "./rules/pages";
import { collectItemHrefs, findDuplicateSlugPatterns, itemLabel, runCmsRules } from "./rules/cms";
import { LinkSource, normalizePath, runSiteRules } from "./rules/site";
import { computeSiteScore, rescoreLatestRun } from "./scoring";

/** Rules that need the whole site; incremental runs leave their existing findings untouched. */
const CROSS_ITEM_RULES = ["cms.slug.duplicate-pattern", "site.links.broken"];

const running = new Set<string>();

export function isAuditRunning(siteId: string): boolean {
  return running.has(siteId);
}

export function loadConfig(siteId: string): RuleConfig {
  const row = db.prepare(`SELECT thin_content_words FROM installations WHERE site_id = ?`).get(siteId) as { thin_content_words: number } | undefined;
  return { thinContentWords: row?.thin_content_words ?? 300 };
}

function isStaticPage(p: WfPage): boolean {
  return !p.collectionId && !p.draft && !p.archived;
}

function pagePath(p: WfPage): string {
  if (p.publishedPath) return normalizePath(p.publishedPath);
  return p.slug ? normalizePath(`/${p.slug}`) : "/";
}

const insertStmt = () =>
  db.prepare(
    `INSERT INTO findings (id, site_id, run_id, subject_type, subject_id, subject_label, collection_id, rule_id, severity, message,
       current_value, suggested_value, fix_kind, fix_field, fix_patch, manual_steps, element_id, detail_key, status, created_at)
     VALUES (@id, @site_id, @run_id, @subject_type, @subject_id, @subject_label, @collection_id, @rule_id, @severity, @message,
       @current_value, @suggested_value, @fix_kind, @fix_field, @fix_patch, @manual_steps, @element_id, @detail_key, 'open', datetime('now'))`
  );

function insertDrafts(siteId: string, runId: number, defaultSubject: SubjectRef, drafts: FindingDraft[]): void {
  const stmt = insertStmt();
  for (const d of drafts) {
    const s = d.subject ?? defaultSubject;
    stmt.run({
      id: uuid(),
      site_id: siteId,
      run_id: runId,
      subject_type: s.type,
      subject_id: s.id,
      subject_label: s.label,
      collection_id: s.collectionId ?? null,
      rule_id: d.ruleId,
      severity: d.severity,
      message: d.message,
      current_value: d.currentValue ?? null,
      suggested_value: d.suggestedValue ?? null,
      fix_kind: d.fixKind,
      fix_field: d.fixField ?? null,
      fix_patch: d.fixPatch ? JSON.stringify(d.fixPatch) : null,
      manual_steps: d.manualSteps ?? null,
      element_id: d.elementId ?? null,
      detail_key: d.detailKey ?? null,
    });
  }
}

function createRun(siteId: string, kind: "full" | "incremental", trigger: string): number {
  const r = db
    .prepare(`INSERT INTO audit_runs (site_id, kind, trigger_source, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))`)
    .run(siteId, kind, trigger);
  return Number(r.lastInsertRowid);
}

function failRun(runId: number, err: unknown): void {
  db.prepare(`UPDATE audit_runs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`).run(
    err instanceof Error ? err.message.slice(0, 500) : String(err),
    runId
  );
}

function completeRun(siteId: string, runId: number, pages: number, items: number): void {
  const s = computeSiteScore(siteId);
  db.prepare(
    `UPDATE audit_runs SET status = 'complete', finished_at = datetime('now'), site_score = ?, pages_scanned = ?, items_scanned = ?,
       subjects_total = ?, critical_count = ?, warning_count = ?, info_count = ? WHERE id = ?`
  ).run(s.score, pages, items, s.subjectsTotal, s.critical, s.warning, s.info, runId);
}

/** Creates the run row and starts the crawl in the background. Returns null if one is already running for the site. */
export function startFullAudit(siteId: string, trigger: "manual" | "schedule" | "webhook" = "manual"): number | null {
  if (running.has(siteId)) return null;
  running.add(siteId);
  const runId = createRun(siteId, "full", trigger);
  runFullAudit(siteId, runId)
    .catch((err) => failRun(runId, err))
    .finally(() => running.delete(siteId));
  return runId;
}

async function runFullAudit(siteId: string, runId: number): Promise<void> {
  const config = loadConfig(siteId);
  const site = await webflowClient.getSite(siteId);
  const siteName = site.displayName || site.shortName;
  const hostnames = [
    ...(site.customDomains ?? []).map((d) => {
      try {
        return new URL(/^https?:\/\//.test(d.url) ? d.url : `https://${d.url}`).hostname.toLowerCase();
      } catch {
        return d.url.toLowerCase();
      }
    }),
    ...(site.shortName ? [`${site.shortName}.webflow.io`] : []),
  ];

  // ---- static pages ----
  const allPages = await webflowClient.listAllPages(siteId);
  const staticPages = allPages.filter(isStaticPage);
  const doms = new Map<string, DomSummary | null>();
  for (const p of staticPages) {
    try {
      doms.set(p.id, summarizeDom(await webflowClient.getPageDom(siteId, p.id)));
    } catch {
      doms.set(p.id, null); // DOM unreadable: heading rules are skipped for this page
    }
  }
  const index = buildPageIndex(staticPages);

  const knownPaths = new Set<string>(["/"]);
  const linkSources: LinkSource[] = [];
  const pageResults: Array<{ subject: SubjectRef; drafts: FindingDraft[] }> = [];

  for (const p of staticPages) {
    knownPaths.add(pagePath(p));
    const subject: SubjectRef = { type: "page", id: p.id, label: p.title || p.slug || "Home" };
    const dom = doms.get(p.id) ?? null;
    pageResults.push({ subject, drafts: runPageRules(p, dom, index, siteName) });
    if (dom) linkSources.push({ subject, hrefs: dom.hrefs });
  }

  // ---- CMS ----
  const collections = await webflowClient.listCollections(siteId);
  const cmsResults: Array<{ subject: SubjectRef; drafts: FindingDraft[] }> = [];
  let itemsScanned = 0;
  for (const summary of collections) {
    const collection = await webflowClient.getCollection(siteId, summary.id);
    const items = (await webflowClient.listAllItems(siteId, collection.id)).filter((i) => !i.isArchived);
    const prefixes = new Set<string>([collection.slug]);
    allPages.filter((p) => p.collectionId === collection.id).forEach((t) => t.slug && prefixes.add(t.slug));
    const dupes = findDuplicateSlugPatterns(collection, items);

    for (const item of items) {
      itemsScanned += 1;
      const subject: SubjectRef = { type: "cms_item", id: item.id, label: itemLabel(collection, item), collectionId: collection.id };
      const drafts = runCmsRules(collection, item, config);
      const dup = dupes.get(item.id);
      if (dup) drafts.push(dup);
      cmsResults.push({ subject, drafts });
      const slug = typeof item.fieldData.slug === "string" ? item.fieldData.slug : "";
      if (slug) prefixes.forEach((pre) => knownPaths.add(normalizePath(`/${pre}/${slug}`)));
      const hrefs = collectItemHrefs(collection, item);
      if (hrefs.length) linkSources.push({ subject, hrefs });
    }
  }

  // ---- site level ----
  const robots = await webflowClient.getRobots(siteId).catch(() => null);
  const redirects = await webflowClient.listRedirects(siteId).catch(() => []);
  const siteDrafts = runSiteRules({ siteId, site, robots, redirects, knownPaths, hostnames, linkSources });

  // ---- persist atomically ----
  const save = db.transaction(() => {
    db.prepare(`DELETE FROM findings WHERE site_id = ?`).run(siteId);
    db.prepare(`DELETE FROM audit_subjects WHERE site_id = ?`).run(siteId);
    const addSubject = db.prepare(`INSERT OR IGNORE INTO audit_subjects (site_id, subject_type, subject_id) VALUES (?, ?, ?)`);
    const siteSubject: SubjectRef = { type: "site", id: siteId, label: "Site settings" };

    for (const r of [...pageResults, ...cmsResults]) {
      addSubject.run(siteId, r.subject.type, r.subject.id);
      insertDrafts(siteId, runId, r.subject, r.drafts.filter((d) => !d.subject));
    }
    // Site-level rules may attribute findings to pages/items (broken links) or to the site itself.
    insertDrafts(siteId, runId, siteSubject, siteDrafts);
    completeRun(siteId, runId, staticPages.length, itemsScanned);
  });
  save();
}

// ---------------------------------------------------------------------------
// Incremental audits (webhook driven)
// ---------------------------------------------------------------------------

function replaceSubjectFindings(siteId: string, runId: number, subject: SubjectRef, drafts: FindingDraft[]): void {
  const placeholders = CROSS_ITEM_RULES.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM findings WHERE site_id = ? AND subject_type = ? AND subject_id = ? AND rule_id NOT IN (${placeholders})`
  ).run(siteId, subject.type, subject.id, ...CROSS_ITEM_RULES);
  db.prepare(`INSERT OR IGNORE INTO audit_subjects (site_id, subject_type, subject_id) VALUES (?, ?, ?)`).run(siteId, subject.type, subject.id);
  insertDrafts(siteId, runId, subject, drafts.filter((d) => !CROSS_ITEM_RULES.includes(d.ruleId)));
}

function removeSubject(siteId: string, type: string, id: string): void {
  db.prepare(`DELETE FROM findings WHERE site_id = ? AND subject_type = ? AND subject_id = ?`).run(siteId, type, id);
  db.prepare(`DELETE FROM audit_subjects WHERE site_id = ? AND subject_type = ? AND subject_id = ?`).run(siteId, type, id);
}

function hasCompletedFullRun(siteId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM audit_runs WHERE site_id = ? AND kind = 'full' AND status = 'complete' LIMIT 1`).get(siteId);
}

/** Re-checks one CMS item without re-crawling the site. Cross-item rules (duplicate slug pattern, broken links) keep their last full-run findings. */
export async function auditItem(siteId: string, collectionId: string, itemId: string): Promise<void> {
  if (!hasCompletedFullRun(siteId)) return; // nothing to update incrementally yet
  const runId = createRun(siteId, "incremental", "webhook");
  try {
    const collection: WfCollection = await webflowClient.getCollection(siteId, collectionId);
    let item: WfItem;
    try {
      item = await webflowClient.getItem(siteId, collectionId, itemId);
    } catch (err) {
      if (err instanceof WebflowApiError && err.status === 404) {
        removeSubject(siteId, "cms_item", itemId);
        completeRun(siteId, runId, 0, 0);
        return;
      }
      throw err;
    }
    if (item.isArchived) {
      removeSubject(siteId, "cms_item", itemId);
    } else {
      const subject: SubjectRef = { type: "cms_item", id: item.id, label: itemLabel(collection, item), collectionId };
      db.transaction(() => replaceSubjectFindings(siteId, runId, subject, runCmsRules(collection, item, loadConfig(siteId))))();
    }
    completeRun(siteId, runId, 0, 1);
  } catch (err) {
    failRun(runId, err);
    throw err;
  }
}

/** Re-checks one static page. Page-duplicate rules need the page list (cheap: one paginated call), not per-page DOMs. */
export async function auditPage(siteId: string, pageId: string): Promise<void> {
  if (!hasCompletedFullRun(siteId)) return;
  const runId = createRun(siteId, "incremental", "webhook");
  try {
    const site = await webflowClient.getSite(siteId);
    const pages = await webflowClient.listAllPages(siteId);
    const staticPages = pages.filter(isStaticPage);
    const page = staticPages.find((p) => p.id === pageId);
    if (!page) {
      removeSubject(siteId, "page", pageId);
      completeRun(siteId, runId, 0, 0);
      return;
    }
    let dom: DomSummary | null = null;
    try {
      dom = summarizeDom(await webflowClient.getPageDom(siteId, pageId));
    } catch {
      dom = null;
    }
    const subject: SubjectRef = { type: "page", id: page.id, label: page.title || page.slug || "Home" };
    const drafts = runPageRules(page, dom, buildPageIndex(staticPages), site.displayName || site.shortName);
    db.transaction(() => replaceSubjectFindings(siteId, runId, subject, drafts))();
    completeRun(siteId, runId, 1, 0);
  } catch (err) {
    failRun(runId, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Conceptual cron
// ---------------------------------------------------------------------------

/** Runs a full audit for every installed site every `hours` hours (in-process; use an external cron for multi-instance deployments). */
export function startScheduler(hours: number): NodeJS.Timeout | null {
  if (!(hours > 0)) return null;
  return setInterval(() => {
    const sites = db.prepare(`SELECT site_id FROM installations WHERE uninstalled_at IS NULL`).all() as Array<{ site_id: string }>;
    for (const s of sites) startFullAudit(s.site_id, "schedule");
  }, hours * 3600 * 1000);
}

export { rescoreLatestRun };
