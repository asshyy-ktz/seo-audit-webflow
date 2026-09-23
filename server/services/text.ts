// Small text helpers shared by the rule modules.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "is", "are", "was", "be", "from", "as", "it", "this", "that",
]);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Builds a cleaner slug: no stopwords (unless nothing else remains), capped at maxLen on a hyphen boundary. */
export function improveSlug(slug: string, maxLen = 60): string {
  const tokens = slugify(slug).split("-").filter(Boolean);
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  const use = meaningful.length ? meaningful : tokens;
  let out = "";
  for (const t of use) {
    const next = out ? `${out}-${t}` : t;
    if (next.length > maxLen) break;
    out = next;
  }
  return out || slugify(slug).slice(0, maxLen);
}

export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1].trim());
  return out;
}

/** First ~max characters of body text, cut on a word boundary. */
export function generateDescription(text: string, max = 155): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-]+$/, "");
  return `${base}…`;
}

/** Title suggestion aiming for the 50-60 character sweet spot. */
export function generateTitle(base: string, siteName?: string): string {
  const b = base.trim();
  if (b.length >= 50 && b.length <= 60) return b;
  if (siteName) {
    const withSite = `${b} | ${siteName}`;
    if (withSite.length >= 50 && withSite.length <= 60) return withSite;
    if (b.length < 50 && withSite.length <= 60) return withSite;
  }
  if (b.length > 60) {
    const cut = b.slice(0, 60);
    const sp = cut.lastIndexOf(" ");
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:\-|]+$/, "");
  }
  return b;
}
