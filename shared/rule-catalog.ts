import { Severity } from "./types";

export interface RuleInfo {
  severity: Severity;
  category: "pages" | "cms" | "site";
  title: string;
}

/** Single source of truth for rule severities. Rules build findings through `draft()` which reads from here. */
export const RULE_CATALOG: Record<string, RuleInfo> = {
  "page.title.missing": { severity: "critical", category: "pages", title: "Missing title tag" },
  "page.title.duplicate": { severity: "warning", category: "pages", title: "Duplicate title tag" },
  "page.title.length": { severity: "warning", category: "pages", title: "Title length outside 50-60 characters" },
  "page.desc.missing": { severity: "warning", category: "pages", title: "Missing meta description" },
  "page.desc.duplicate": { severity: "warning", category: "pages", title: "Duplicate meta description" },
  "page.desc.length": { severity: "info", category: "pages", title: "Description length outside 120-160 characters" },
  "page.og.image.missing": { severity: "warning", category: "pages", title: "Missing Open Graph image" },
  "page.content.duplicate-meta": { severity: "warning", category: "pages", title: "Identical title and description on multiple pages" },
  "page.h1.missing": { severity: "critical", category: "pages", title: "No H1 heading" },
  "page.h1.multiple": { severity: "warning", category: "pages", title: "Multiple H1 headings" },
  "page.heading.skip": { severity: "info", category: "pages", title: "Skipped heading level" },
  "cms.seo.title-empty": { severity: "warning", category: "cms", title: "SEO title field empty" },
  "cms.seo.description-empty": { severity: "warning", category: "cms", title: "SEO description field empty" },
  "cms.slug.special-chars": { severity: "warning", category: "cms", title: "Slug has uppercase or special characters" },
  "cms.slug.stopwords": { severity: "info", category: "cms", title: "Slug contains stopwords" },
  "cms.slug.too-long": { severity: "warning", category: "cms", title: "Slug is overly long" },
  "cms.image.alt-missing": { severity: "warning", category: "cms", title: "Image missing alt text" },
  "cms.content.thin": { severity: "warning", category: "cms", title: "Thin content" },
  "cms.slug.duplicate-pattern": { severity: "info", category: "cms", title: "Duplicate slug pattern" },
  "site.robots.blocks-all": { severity: "critical", category: "site", title: "robots.txt blocks all crawlers" },
  "site.robots.no-sitemap": { severity: "warning", category: "site", title: "No sitemap declared in robots.txt" },
  "site.not-published": { severity: "warning", category: "site", title: "Site has never been published" },
  "site.redirect.chain": { severity: "warning", category: "site", title: "Redirect chain" },
  "site.redirect.loop": { severity: "critical", category: "site", title: "Redirect loop" },
  "site.links.broken": { severity: "warning", category: "site", title: "Broken internal link" },
};

export const SEVERITY_WEIGHTS: Record<Severity, number> = { critical: 10, warning: 4, info: 1 };

export function ruleTitle(ruleId: string): string {
  return RULE_CATALOG[ruleId]?.title ?? ruleId;
}
