// Fix-assist: applies suggested values for CMS findings through the Data API.

import { db } from "../db";
import { webflowClient } from "./webflow-client";
import { rescoreLatestRun } from "./scoring";

interface FixRow {
  id: string;
  site_id: string;
  subject_type: string;
  subject_id: string;
  collection_id: string | null;
  fix_kind: string;
  fix_field: string | null;
  fix_patch: string | null;
  status: string;
}

export class FixError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ApplyFixOptions {
  /** Replaces the suggested string value (only for single string-valued patches). */
  value?: string;
  /** Publish the item immediately (PATCH .../live) instead of leaving it staged. */
  publish?: boolean;
}

export async function applyFix(siteId: string, findingId: string, opts: ApplyFixOptions = {}): Promise<void> {
  const row = db.prepare(`SELECT * FROM findings WHERE id = ? AND site_id = ?`).get(findingId, siteId) as FixRow | undefined;
  if (!row) throw new FixError(404, "Finding not found");
  if (row.fix_kind !== "api_patch" || row.subject_type !== "cms_item" || !row.collection_id || !row.fix_patch) {
    throw new FixError(400, "This finding cannot be fixed through the API; follow the manual steps in the Designer.");
  }

  let patch = JSON.parse(row.fix_patch) as Record<string, unknown>;
  if (typeof opts.value === "string" && opts.value.trim() && row.fix_field && typeof patch[row.fix_field] === "string") {
    patch = { [row.fix_field]: opts.value.trim() };
  }

  if (opts.publish) {
    await webflowClient.updateItemLive(siteId, row.collection_id, row.subject_id, patch);
  } else {
    await webflowClient.updateItem(siteId, row.collection_id, row.subject_id, patch);
  }

  db.prepare(`UPDATE findings SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`).run(findingId);
  rescoreLatestRun(siteId);
}
