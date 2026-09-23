import { RULE_CATALOG } from "../../../shared/rule-catalog";
import { FindingDraft } from "../../../shared/types";

type Extra = Partial<Omit<FindingDraft, "ruleId" | "severity" | "message" | "fixKind">> & { fixKind?: FindingDraft["fixKind"] };

/** Builds a finding whose severity comes from the central rule catalog. */
export function draft(ruleId: string, message: string, extra: Extra = {}): FindingDraft {
  const info = RULE_CATALOG[ruleId];
  if (!info) throw new Error(`Unknown rule id ${ruleId}`);
  return { ruleId, severity: info.severity, message, fixKind: "manual", ...extra };
}
