// Page-level SEO rules (static pages only).

import { FindingDraft, WfDomNode, WfPage } from "../../../shared/types";
import { generateDescription, generateTitle, norm, stripHtml, extractHrefs } from "../text";
import { draft } from "./util";

export interface Heading {
  level: number;
  nodeId: string;
  text: string;
}

export interface DomSummary {
  headings: Heading[];
  bodyText: string;
  hasImage: boolean;
  firstImageUrl: string | null;
  hrefs: string[];
}

export interface PageIndex {
  titles: Map<string, string[]>;
  descs: Map<string, string[]>;
  pairs: Map<string, string[]>;
}

function nodeTag(node: WfDomNode): string {
  const attrTag = typeof node.attributes?.tag === "string" ? (node.attributes.tag as string) : "";
  return (node.tag || attrTag || "").toLowerCase();
}

export function summarizeDom(nodes: WfDomNode[]): DomSummary {
  const headings: Heading[] = [];
  const paragraphs: string[] = [];
  const hrefs: string[] = [];
  let hasImage = false;
  let firstImageUrl: string | null = null;

  for (const node of nodes) {
    const html = node.text?.html ?? "";
    const text = node.text?.text ?? (html ? stripHtml(html) : "");
    const tag = nodeTag(node);
    const m = /^h([1-6])$/.exec(tag);
    if (m) {
      headings.push({ level: Number(m[1]), nodeId: node.id, text });
    } else if (text && text.length > 40) {
      paragraphs.push(text);
    }
    if (html) hrefs.push(...extractHrefs(html));
    if (node.type === "image" || node.image) {
      hasImage = true;
      if (!firstImageUrl && node.image?.url) firstImageUrl = node.image.url;
    }
  }
  return { headings, bodyText: paragraphs.join(" "), hasImage, firstImageUrl, hrefs };
}

export function buildPageIndex(pages: WfPage[]): PageIndex {
  const idx: PageIndex = { titles: new Map(), descs: new Map(), pairs: new Map() };
  const add = (m: Map<string, string[]>, key: string, id: string) => {
    if (!key) return;
    const arr = m.get(key) ?? [];
    arr.push(id);
    m.set(key, arr);
  };
  for (const p of pages) {
    const t = norm(p.seo?.title);
    const d = norm(p.seo?.description);
    add(idx.titles, t, p.id);
    add(idx.descs, d, p.id);
    if (t && d) add(idx.pairs, `${t}\u0000${d}`, p.id);
  }
  return idx;
}

const SETTINGS_TITLE = "Open Pages panel > this page's settings (gear icon) > SEO Settings > Title Tag.";
const SETTINGS_DESC = "Open Pages panel > this page's settings (gear icon) > SEO Settings > Meta Description.";

export function runPageRules(page: WfPage, dom: DomSummary | null, index: PageIndex, siteName?: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  const title = (page.seo?.title ?? "").trim();
  const desc = (page.seo?.description ?? "").trim();
  const tNorm = norm(title);
  const dNorm = norm(desc);
  const suggestedTitle = generateTitle(page.title, siteName);
  const suggestedDesc = dom && dom.bodyText ? generateDescription(dom.bodyText) : null;

  // ---- title ----
  if (!title) {
    out.push(draft("page.title.missing", "This page has no SEO title tag; search engines will guess one.", {
      suggestedValue: suggestedTitle,
      manualSteps: SETTINGS_TITLE,
    }));
  } else {
    if (title.length < 50 || title.length > 60) {
      out.push(draft("page.title.length", `Title is ${title.length} characters; aim for 50-60.`, {
        currentValue: title,
        suggestedValue: generateTitle(title, siteName),
        manualSteps: SETTINGS_TITLE,
      }));
    }
    const dupes = index.titles.get(tNorm) ?? [];
    if (dupes.length > 1) {
      out.push(draft("page.title.duplicate", `Same title is used on ${dupes.length} pages.`, {
        currentValue: title,
        suggestedValue: generateTitle(`${page.title} - ${page.slug || "home"}`, siteName),
        manualSteps: SETTINGS_TITLE,
      }));
    }
  }

  // ---- description ----
  if (!desc) {
    out.push(draft("page.desc.missing", "This page has no meta description.", {
      suggestedValue: suggestedDesc,
      manualSteps: SETTINGS_DESC,
    }));
  } else {
    if (desc.length < 120 || desc.length > 160) {
      out.push(draft("page.desc.length", `Description is ${desc.length} characters; aim for 120-160.`, {
        currentValue: desc,
        suggestedValue: suggestedDesc,
        manualSteps: SETTINGS_DESC,
      }));
    }
    const dupes = index.descs.get(dNorm) ?? [];
    if (dupes.length > 1) {
      out.push(draft("page.desc.duplicate", `Same description is used on ${dupes.length} pages.`, {
        currentValue: desc,
        suggestedValue: suggestedDesc,
        manualSteps: SETTINGS_DESC,
      }));
    }
  }

  // ---- identical title + description (canonical awkwardness) ----
  if (tNorm && dNorm) {
    const same = index.pairs.get(`${tNorm}\u0000${dNorm}`) ?? [];
    if (same.length > 1) {
      out.push(draft("page.content.duplicate-meta", `${same.length} pages share identical title and description. Give each a unique pair or set a canonical URL.`, {
        currentValue: `${title} / ${desc}`,
        manualSteps: "Make the title or description unique, or point duplicates at one URL using Page settings > SEO Settings > Canonical URL / 301 redirects.",
      }));
    }
  }

  // ---- Open Graph image ----
  const og = page.openGraph;
  const ogImage = og && (og.image || og.imageUrl);
  if (!ogImage) {
    out.push(draft("page.og.image.missing", "No Open Graph image is set, so social shares show no preview image.", {
      suggestedValue: dom?.firstImageUrl ?? null,
      manualSteps: "Open Pages panel > this page's settings > Open Graph Settings > upload or pick an Open Graph image (1200x630 recommended).",
    }));
  }

  // ---- headings (only when DOM was readable) ----
  if (dom) {
    const h1s = dom.headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      const first = dom.headings[0];
      out.push(draft("page.h1.missing", "The page has no H1 heading.", {
        currentValue: first ? `First heading is an H${first.level}: ${first.text}` : null,
        suggestedValue: page.title,
        elementId: first?.nodeId ?? null,
        manualSteps: "Select your main headline element and set its tag to H1 in the Element Settings panel.",
      }));
    } else if (h1s.length > 1) {
      h1s.slice(1).forEach((h) => {
        out.push(draft("page.h1.multiple", `The page has ${h1s.length} H1 headings; this one is extra.`, {
          currentValue: h.text,
          elementId: h.nodeId,
          detailKey: h.nodeId,
          manualSteps: "Change this heading's tag to H2 (or the appropriate level) in Element Settings.",
        }));
      });
    }
    let prev = 0;
    for (const h of dom.headings) {
      if (prev && h.level > prev + 1) {
        out.push(draft("page.heading.skip", `Heading jumps from H${prev} to H${h.level}.`, {
          currentValue: h.text,
          elementId: h.nodeId,
          detailKey: h.nodeId,
          manualSteps: `Change this heading to H${prev + 1} so levels descend one at a time.`,
        }));
      }
      prev = h.level;
    }
  }

  return out;
}
