// CMS item SEO rules.

import { FindingDraft, RuleConfig, WfCollection, WfField, WfItem } from "../../../shared/types";
import { extractHrefs, generateDescription, generateTitle, improveSlug, slugify, STOPWORDS, stripHtml, wordCount } from "../text";
import { draft } from "./util";

const TITLE_FIELD = /(seo|meta).*title|title.*tag/i;
const DESC_FIELD = /(seo|meta).*desc/i;
const MAX_SLUG = 60;

function fieldsOf(c: WfCollection): WfField[] {
  return c.fields ?? [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function itemLabel(collection: WfCollection, item: WfItem): string {
  const name = str(item.fieldData.name) || str(item.fieldData.slug) || item.id;
  return `${collection.displayName}: ${name}`;
}

/** Concatenated plain text of every RichText field. */
export function bodyTextOf(collection: WfCollection, item: WfItem): string {
  return fieldsOf(collection)
    .filter((f) => f.type === "RichText")
    .map((f) => stripHtml(str(item.fieldData[f.slug])))
    .filter(Boolean)
    .join(" ");
}

/** Internal-link candidates from RichText HTML and Link fields. */
export function collectItemHrefs(collection: WfCollection, item: WfItem): string[] {
  const out: string[] = [];
  for (const f of fieldsOf(collection)) {
    const v = item.fieldData[f.slug];
    if (f.type === "RichText" && typeof v === "string") out.push(...extractHrefs(v));
    else if (f.type === "Link" && typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

interface ImageValue {
  fileId?: string;
  url?: string;
  alt?: string | null;
  [k: string]: unknown;
}

function isImage(v: unknown): v is ImageValue {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function runCmsRules(collection: WfCollection, item: WfItem, config: RuleConfig): FindingDraft[] {
  const out: FindingDraft[] = [];
  const fields = fieldsOf(collection);
  const data = item.fieldData;
  const name = str(data.name);
  const body = bodyTextOf(collection, item);

  // ---- SEO title / description fields ----
  for (const f of fields) {
    if (f.type !== "PlainText" && f.type !== "RichText") continue;
    const value = stripHtml(str(data[f.slug]));
    if (TITLE_FIELD.test(f.slug) && !value) {
      const suggestion = name ? generateTitle(name) : null;
      out.push(draft("cms.seo.title-empty", `"${f.displayName}" is empty.`, {
        fixKind: suggestion ? "api_patch" : "manual",
        fixField: f.slug,
        fixPatch: suggestion ? { [f.slug]: suggestion } : null,
        suggestedValue: suggestion,
        detailKey: f.slug,
        manualSteps: `Open this item in the CMS and fill in "${f.displayName}".`,
      }));
    } else if (DESC_FIELD.test(f.slug) && !value) {
      const suggestion = body ? generateDescription(body) : null;
      out.push(draft("cms.seo.description-empty", `"${f.displayName}" is empty.`, {
        fixKind: suggestion ? "api_patch" : "manual",
        fixField: f.slug,
        fixPatch: suggestion ? { [f.slug]: suggestion } : null,
        suggestedValue: suggestion,
        detailKey: f.slug,
        manualSteps: `Open this item in the CMS and fill in "${f.displayName}".`,
      }));
    }
  }

  // ---- slug quality ----
  const slug = str(data.slug);
  if (slug) {
    const improved = improveSlug(slug, MAX_SLUG);
    const redirectNote = " Changing a slug changes the live URL; add a 301 redirect from the old path.";
    const patch = improved && improved !== slug ? { slug: improved } : null;
    const slugExtra = {
      fixKind: patch ? ("api_patch" as const) : ("manual" as const),
      fixField: "slug",
      fixPatch: patch,
      suggestedValue: improved !== slug ? improved : null,
      currentValue: slug,
      manualSteps: "Edit the Slug field in the CMS item settings, then add a 301 redirect from the old URL.",
    };
    const messy = /[A-Z]/.test(slug) || /[^a-zA-Z0-9-]/.test(slug) || /--/.test(slug);
    if (messy) {
      out.push(draft("cms.slug.special-chars", `Slug contains uppercase or special characters.${redirectNote}`, slugExtra));
    } else if (slug.length > MAX_SLUG) {
      out.push(draft("cms.slug.too-long", `Slug is ${slug.length} characters; keep it under ${MAX_SLUG}.${redirectNote}`, slugExtra));
    } else {
      const tokens = slug.split("-");
      const stops = tokens.filter((t) => STOPWORDS.has(t));
      if (stops.length && tokens.length - stops.length >= 1) {
        out.push(draft("cms.slug.stopwords", `Slug contains stopwords (${[...new Set(stops)].join(", ")}).${redirectNote}`, slugExtra));
      }
    }
    if (messy && slug.length > MAX_SLUG) {
      out.push(draft("cms.slug.too-long", `Slug is ${slug.length} characters; keep it under ${MAX_SLUG}.${redirectNote}`, slugExtra));
    }
  }

  // ---- image alt text ----
  for (const f of fields) {
    const v = data[f.slug];
    if (f.type === "Image" && isImage(v) && v.url && !str(v.alt)) {
      const alt = name || humanize(v.url);
      out.push(draft("cms.image.alt-missing", `Image in "${f.displayName}" has no alt text.`, {
        fixKind: "api_patch",
        fixField: f.slug,
        fixPatch: { [f.slug]: { ...v, alt } },
        suggestedValue: alt,
        currentValue: v.url,
        detailKey: f.slug,
        manualSteps: `Open this item in the CMS and add alt text to "${f.displayName}".`,
      }));
    } else if (f.type === "MultiImage" && Array.isArray(v)) {
      const imgs = v as unknown[];
      const missing = imgs.filter((i) => isImage(i) && i.url && !str(i.alt)).length;
      if (missing > 0) {
        const alt = name || "Image";
        const patched = imgs.map((i, n) => (isImage(i) && i.url && !str(i.alt) ? { ...i, alt: `${alt} ${n + 1}` } : i));
        out.push(draft("cms.image.alt-missing", `${missing} image(s) in "${f.displayName}" have no alt text.`, {
          fixKind: "api_patch",
          fixField: f.slug,
          fixPatch: { [f.slug]: patched },
          suggestedValue: `${alt} 1, ${alt} 2, ...`,
          detailKey: f.slug,
          manualSteps: `Open this item in the CMS and add alt text to each image in "${f.displayName}".`,
        }));
      }
    }
  }

  // ---- thin content ----
  if (fields.some((f) => f.type === "RichText")) {
    const words = wordCount(body);
    if (words < config.thinContentWords) {
      out.push(draft("cms.content.thin", `Rich-text content is ${words} words; the threshold is ${config.thinContentWords}.`, {
        currentValue: `${words} words`,
        manualSteps: "Expand the item's rich-text body with useful, original content.",
      }));
    }
  }

  return out;
}

/** Cross-item rule: slugs like "post-2" that look like auto-deduplicated copies of "post". Returns itemId -> finding. */
export function findDuplicateSlugPatterns(collection: WfCollection, items: WfItem[]): Map<string, FindingDraft> {
  const groups = new Map<string, WfItem[]>();
  for (const it of items) {
    const slug = str(it.fieldData.slug);
    if (!slug) continue;
    const base = slug.replace(/-\d+$/, "");
    const arr = groups.get(base) ?? [];
    arr.push(it);
    groups.set(base, arr);
  }
  const out = new Map<string, FindingDraft>();
  groups.forEach((group, base) => {
    if (group.length < 2) return;
    for (const it of group) {
      const slug = str(it.fieldData.slug);
      if (slug === base) continue;
      out.set(it.id, draft("cms.slug.duplicate-pattern", `Slug "${slug}" follows the "${base}-N" pattern shared by ${group.length} items; likely a duplicate of "${base}".`, {
        currentValue: slug,
        suggestedValue: slugify(str(it.fieldData.name)) || null,
        manualSteps: "Give this item a distinct, descriptive slug (or merge it with the original) in the CMS.",
      }));
    }
  });
  return out;
}

function humanize(url: string): string {
  const file = decodeURIComponent(url.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
  return file.replace(/^[0-9a-f]{20,}_/i, "").replace(/[-_]+/g, " ").trim() || "Image";
}
