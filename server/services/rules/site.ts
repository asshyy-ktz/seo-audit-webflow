// Site-level checks: robots/sitemap/indexing, publish state, redirect chains, broken internal links.

import { FindingDraft, SubjectRef, WfRedirect, WfRobots, WfSite } from "../../../shared/types";
import { draft } from "./util";

export interface LinkSource {
  subject: SubjectRef;
  hrefs: string[];
}

export interface SiteRuleInput {
  siteId: string;
  site: WfSite | null;
  robots: WfRobots | null;
  redirects: WfRedirect[];
  /** Normalized paths (lowercase, no trailing slash) of every known page and CMS item URL. */
  knownPaths: Set<string>;
  hostnames: string[];
  linkSources: LinkSource[];
}

export function normalizePath(p: string): string {
  let out = p.split("#")[0].split("?")[0].trim().toLowerCase();
  if (!out.startsWith("/")) out = `/${out}`;
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out || "/";
}

/** Returns the normalized internal path for an href, or null when the link is external / not checkable. */
export function internalPath(href: string, hostnames: string[]): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  let pathPart = h;
  if (/^https?:\/\//i.test(h) || h.startsWith("//")) {
    try {
      const u = new URL(h.startsWith("//") ? `https:${h}` : h);
      if (!hostnames.includes(u.hostname.toLowerCase())) return null;
      pathPart = u.pathname;
    } catch {
      return null;
    }
  } else if (!h.startsWith("/")) {
    return null; // relative-to-page links can't be resolved reliably
  }
  const last = pathPart.split("?")[0].split("#")[0].split("/").pop() || "";
  if (/\.[a-z0-9]{2,5}$/i.test(last) && !/\.html?$/i.test(last)) return null; // asset / file link
  return normalizePath(pathPart);
}

function siteSubject(siteId: string): SubjectRef {
  return { type: "site", id: siteId, label: "Site settings" };
}

export function runSiteRules(input: SiteRuleInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const subject = siteSubject(input.siteId);

  // ---- publish state ----
  if (input.site && !input.site.lastPublished) {
    out.push(draft("site.not-published", "The site has never been published, so nothing is crawlable yet.", {
      subject,
      manualSteps: "Publish the site from the Designer (Publish button, top right).",
    }));
  }

  // ---- robots.txt / sitemap ----
  if (input.robots) {
    const rules = input.robots.rules ?? [];
    const blocksAll = rules.some((r) => r.userAgent === "*" && (r.disallows ?? []).some((d) => d.trim() === "/") && !(r.allows ?? []).length);
    if (blocksAll) {
      out.push(draft("site.robots.blocks-all", "robots.txt disallows \"/\" for all user agents, so the whole site is blocked from search engines.", {
        subject,
        currentValue: "User-agent: *  Disallow: /",
        manualSteps: "Site settings > SEO > robots.txt: remove the blanket Disallow rule, and turn off \"Disable Webflow subdomain indexing\" only if intended.",
      }));
    }
    if (!input.robots.sitemap) {
      out.push(draft("site.robots.no-sitemap", "No sitemap is declared in robots.txt.", {
        subject,
        suggestedValue: input.hostnames[0] ? `Sitemap: https://${input.hostnames[0]}/sitemap.xml` : null,
        manualSteps: "Site settings > SEO > Sitemap: enable \"Auto-generate sitemap\" and publish; optionally add the Sitemap line to robots.txt.",
      }));
    }
  } else {
    out.push(draft("site.robots.no-sitemap", "robots.txt is not configured or could not be read, so no sitemap is declared.", {
      subject,
      manualSteps: "Site settings > SEO: enable the auto-generated sitemap and add a robots.txt, then publish.",
    }));
  }

  // ---- redirects ----
  const map = new Map<string, string>();
  for (const r of input.redirects) {
    if (r.fromUrl && r.toUrl) map.set(normalizePath(r.fromUrl), r.toUrl);
  }
  const targets = new Set<string>();
  map.forEach((to) => {
    const p = internalPath(to, input.hostnames);
    if (p) targets.add(p);
  });
  const seenLoops = new Set<string>();
  map.forEach((firstTo, from) => {
    const path: string[] = [from];
    let cur: string | null = internalPath(firstTo, input.hostnames);
    let looped = false;
    while (cur) {
      if (path.includes(cur)) {
        looped = true;
        path.push(cur);
        break;
      }
      path.push(cur);
      const next = map.get(cur);
      cur = next ? internalPath(next, input.hostnames) : null;
      if (path.length > 12) break;
    }
    if (looped) {
      const key = [...new Set(path)].sort().join("|");
      if (seenLoops.has(key)) return;
      seenLoops.add(key);
      out.push(draft("site.redirect.loop", `Redirects loop: ${path.join(" -> ")}.`, {
        subject,
        detailKey: from,
        currentValue: path.join(" -> "),
        manualSteps: "Site settings > Publishing > 301 Redirects: delete or correct one redirect in the loop.",
      }));
    } else if (path.length > 2 && !targets.has(from)) {
      const finalDest = path[path.length - 1];
      out.push(draft("site.redirect.chain", `Redirect chain of ${path.length - 1} hops: ${path.join(" -> ")}.`, {
        subject,
        detailKey: from,
        currentValue: path.join(" -> "),
        suggestedValue: `${from} -> ${finalDest}`,
        manualSteps: `Site settings > Publishing > 301 Redirects: point ${from} straight at ${finalDest}.`,
      }));
    }
  });

  // ---- broken internal links ----
  for (const src of input.linkSources) {
    const reported = new Set<string>();
    for (const href of src.hrefs) {
      const p = internalPath(href, input.hostnames);
      if (!p || reported.has(p)) continue;
      if (input.knownPaths.has(p) || map.has(p)) continue;
      reported.add(p);
      out.push(draft("site.links.broken", `Internal link "${href}" does not match any known page, CMS item or redirect.`, {
        subject: src.subject,
        detailKey: href,
        currentValue: href,
        manualSteps: src.subject.type === "page"
          ? "Select the link element, then fix its URL in Element Settings, or add a 301 redirect for the target."
          : "Edit the item's rich text / link field in the CMS to fix the URL, or add a 301 redirect for the target.",
      }));
    }
  }

  return out;
}
