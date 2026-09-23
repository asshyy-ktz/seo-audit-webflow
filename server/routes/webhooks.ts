import { Router } from "express";
import { db } from "../db";
import { auditItem, auditPage } from "../services/auditor";

const router = Router();

interface HookPayload {
  siteId?: string;
  id?: string;
  pageId?: string;
  collectionId?: string;
  itemId?: string;
}

/** Coalesces bursts of identical events (Webflow can send several per edit). */
const recent = new Map<string, number>();
function dedupe(key: string, windowMs = 3000): boolean {
  const now = Date.now();
  const last = recent.get(key);
  recent.set(key, now);
  if (recent.size > 500) {
    recent.forEach((t, k) => {
      if (now - t > 60000) recent.delete(k);
    });
  }
  return last !== undefined && now - last < windowMs;
}

function isActive(siteId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`).get(siteId);
}

function later(fn: () => Promise<void>): void {
  setTimeout(() => {
    fn().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Incremental audit failed:", err instanceof Error ? err.message : err);
    });
  }, 1500); // small delay so Webflow's read-after-write is consistent
}

router.post("/page-created", (req, res) => {
  const p = (req.body?.payload ?? {}) as HookPayload;
  res.status(200).json({ received: true });
  const pageId = p.pageId || p.id;
  if (!p.siteId || !pageId || !isActive(p.siteId) || dedupe(`page:${pageId}`)) return;
  const siteId = p.siteId;
  later(() => auditPage(siteId, pageId));
});

router.post("/collection-item-changed", (req, res) => {
  const p = (req.body?.payload ?? {}) as HookPayload;
  res.status(200).json({ received: true });
  const itemId = p.itemId || p.id;
  if (!p.siteId || !p.collectionId || !itemId || !isActive(p.siteId) || dedupe(`item:${itemId}`)) return;
  const siteId = p.siteId;
  const collectionId = p.collectionId;
  later(() => auditItem(siteId, collectionId, itemId));
});

/** Revokes the token and purges all audit history for the site. */
router.post("/app-uninstalled", async (req, res) => {
  const siteId = req.body?.payload?.siteId as string | undefined;
  if (!siteId) {
    res.status(400).json({ error: "Missing siteId" });
    return;
  }

  const row = db.prepare(`SELECT access_token FROM installations WHERE site_id = ?`).get(siteId) as { access_token: string } | undefined;
  if (row?.access_token) {
    try {
      await fetch("https://api.webflow.com/oauth/revoke_authorization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.WEBFLOW_CLIENT_ID || "",
          client_secret: process.env.WEBFLOW_CLIENT_SECRET || "",
          access_token: row.access_token,
        }),
      });
    } catch {
      // Best effort: the token is discarded locally regardless.
    }
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM findings WHERE site_id = ?`).run(siteId);
    db.prepare(`DELETE FROM ignore_rules WHERE site_id = ?`).run(siteId);
    db.prepare(`DELETE FROM audit_subjects WHERE site_id = ?`).run(siteId);
    db.prepare(`DELETE FROM audit_runs WHERE site_id = ?`).run(siteId);
    db.prepare(`UPDATE installations SET access_token = '', uninstalled_at = datetime('now') WHERE site_id = ?`).run(siteId);
  })();
  res.status(200).json({ ok: true });
});

export default router;
