// Hand-rolled typed client for Webflow Data API v2. No SDK dependency.

import { db } from "../db";
import { WfCollection, WfDomNode, WfItem, WfPage, WfRedirect, WfRobots, WfSite } from "../../shared/types";

const API_BASE = "https://api.webflow.com/v2";
const PAGE_SIZE = 100;

class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

function getAccessToken(siteId: string): string {
  const row = db
    .prepare(`SELECT access_token FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`)
    .get(siteId) as { access_token: string } | undefined;
  if (!row) throw new Error(`No active installation for site ${siteId}`);
  return row.access_token;
}

/** Token-bucket limiter respecting Webflow's documented ~60 req/min per-site limit. */
class RateLimiter {
  private tokens = 60;
  private lastRefill = Date.now();

  private refill() {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60000;
    if (elapsedMin > 0) {
      this.tokens = Math.min(60, this.tokens + elapsedMin * 60);
      this.lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / 60) * 60000;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(siteId: string): RateLimiter {
  if (!limiters.has(siteId)) limiters.set(siteId, new RateLimiter());
  return limiters.get(siteId)!;
}

async function request<T>(siteId: string, method: string, urlPath: string, body?: unknown, retryCount = 0): Promise<T> {
  await limiterFor(siteId).acquire();
  const token = getAccessToken(siteId);

  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && retryCount < 3) {
    const retryAfterSec = Number(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000 * Math.pow(2, retryCount)));
    return request<T>(siteId, method, urlPath, body, retryCount + 1);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new WebflowApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

interface Paged {
  pagination?: { total?: number; offset?: number; limit?: number };
}

/** Walks offset/limit pagination and concatenates the array stored under `key`. */
async function paginate<T>(siteId: string, basePath: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  const sep = basePath.includes("?") ? "&" : "?";
  for (;;) {
    const page = await request<Paged & Record<string, unknown>>(siteId, "GET", `${basePath}${sep}offset=${offset}&limit=${PAGE_SIZE}`);
    const rows = (page[key] as T[] | undefined) ?? [];
    out.push(...rows);
    const total = page.pagination?.total;
    offset += PAGE_SIZE;
    if (rows.length < PAGE_SIZE || (typeof total === "number" && offset >= total)) break;
  }
  return out;
}

export const webflowClient = {
  getSite(siteId: string): Promise<WfSite> {
    return request(siteId, "GET", `/sites/${siteId}`);
  },

  /** All pages of the site (static + CMS template pages), every result page fetched. */
  listAllPages(siteId: string): Promise<WfPage[]> {
    return paginate<WfPage>(siteId, `/sites/${siteId}/pages`, "pages");
  },

  /** Static-content DOM nodes of a page, every result page fetched. */
  getPageDom(siteId: string, pageId: string): Promise<WfDomNode[]> {
    return paginate<WfDomNode>(siteId, `/pages/${pageId}/dom`, "nodes");
  },

  async listCollections(siteId: string): Promise<WfCollection[]> {
    const res = await request<{ collections: WfCollection[] }>(siteId, "GET", `/sites/${siteId}/collections`);
    return res.collections ?? [];
  },

  /** Collection detail including its field schema. */
  getCollection(siteId: string, collectionId: string): Promise<WfCollection> {
    return request(siteId, "GET", `/collections/${collectionId}`);
  },

  listAllItems(siteId: string, collectionId: string): Promise<WfItem[]> {
    return paginate<WfItem>(siteId, `/collections/${collectionId}/items`, "items");
  },

  getItem(siteId: string, collectionId: string, itemId: string): Promise<WfItem> {
    return request(siteId, "GET", `/collections/${collectionId}/items/${itemId}`);
  },

  /** Updates the staged item. */
  updateItem(siteId: string, collectionId: string, itemId: string, fieldData: Record<string, unknown>): Promise<WfItem> {
    return request(siteId, "PATCH", `/collections/${collectionId}/items/${itemId}`, { fieldData });
  },

  /** Updates the item and publishes the change immediately. */
  updateItemLive(siteId: string, collectionId: string, itemId: string, fieldData: Record<string, unknown>): Promise<WfItem> {
    return request(siteId, "PATCH", `/collections/${collectionId}/items/${itemId}/live`, { fieldData });
  },

  async listRedirects(siteId: string): Promise<WfRedirect[]> {
    return paginate<WfRedirect>(siteId, `/sites/${siteId}/redirects`, "redirects");
  },

  getRobots(siteId: string): Promise<WfRobots> {
    return request(siteId, "GET", `/sites/${siteId}/robots_txt`);
  },

  registerWebhook(siteId: string, triggerType: string, url: string): Promise<{ id: string }> {
    return request(siteId, "POST", `/sites/${siteId}/webhooks`, { triggerType, url });
  },
};

export { WebflowApiError };
