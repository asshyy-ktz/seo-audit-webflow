// Types shared between server modules. The Designer panel (plain JS) consumes the JSON shapes below.

export type Severity = "critical" | "warning" | "info";
export type SubjectType = "page" | "cms_item" | "site";
export type FixKind = "api_patch" | "manual";
export type IgnoreScope = "rule" | "item" | "finding";

export interface SubjectRef {
  type: SubjectType;
  id: string;
  label: string;
  collectionId?: string | null;
}

/** A finding produced by a rule, before it is attached to a run / persisted. */
export interface FindingDraft {
  ruleId: string;
  severity: Severity;
  message: string;
  currentValue?: string | null;
  suggestedValue?: string | null;
  fixKind: FixKind;
  fixField?: string | null;
  /** fieldData to PATCH for api_patch findings. */
  fixPatch?: Record<string, unknown> | null;
  manualSteps?: string | null;
  /** Data API DOM node id, used by the panel to select the offending element. */
  elementId?: string | null;
  /** Disambiguates multiple findings of the same rule on one subject (e.g. link href). */
  detailKey?: string | null;
  /** Overrides the default subject (used by site-level rules that report on pages/items). */
  subject?: SubjectRef;
}

export interface RuleConfig {
  thinContentWords: number;
}

// ---- Webflow Data API v2 shapes (only the fields this app reads) ----

export interface WfSite {
  id: string;
  displayName?: string;
  shortName?: string;
  lastPublished?: string | null;
  customDomains?: Array<{ id?: string; url: string }>;
}

export interface WfPage {
  id: string;
  title: string;
  slug: string;
  publishedPath?: string;
  collectionId?: string | null;
  draft?: boolean;
  archived?: boolean;
  seo?: { title?: string | null; description?: string | null };
  openGraph?: { title?: string | null; description?: string | null; image?: unknown; imageUrl?: unknown; [k: string]: unknown };
}

export interface WfDomNode {
  id: string;
  type?: string;
  tag?: string;
  text?: { html?: string; text?: string };
  image?: { url?: string; alt?: string | null; assetId?: string };
  attributes?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface WfField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired?: boolean;
}

export interface WfCollection {
  id: string;
  displayName: string;
  slug: string;
  fields?: WfField[];
}

export interface WfItem {
  id: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}

export interface WfRedirect {
  id?: string;
  fromUrl: string;
  toUrl: string;
}

export interface WfRobots {
  rules?: Array<{ userAgent: string; allows?: string[]; disallows?: string[] }>;
  sitemap?: string | null;
}

// ---- JSON returned to the panel ----

export interface FindingDTO {
  id: string;
  runId: number;
  subjectType: SubjectType;
  subjectId: string;
  subjectLabel: string;
  collectionId: string | null;
  ruleId: string;
  ruleTitle: string;
  severity: Severity;
  message: string;
  currentValue: string | null;
  suggestedValue: string | null;
  fixKind: FixKind;
  fixField: string | null;
  canOverrideValue: boolean;
  manualSteps: string | null;
  elementId: string | null;
  status: "open" | "resolved";
  ignoreRuleId: number | null;
}

export interface AuditRunDTO {
  id: number;
  kind: string;
  triggerSource: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  siteScore: number | null;
  pagesScanned: number;
  itemsScanned: number;
  critical: number;
  warning: number;
  info: number;
  error: string | null;
}
