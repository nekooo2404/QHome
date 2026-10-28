export type ChecklistResultStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export type FailureSeverity = 'NORMAL' | 'CRITICAL';

export interface ChecklistSubmissionItem {
  itemId: string;
  status: ChecklistResultStatus;
  severity?: FailureSeverity;
  notes?: string;
  evidenceRef?: string;
}

export interface ChecklistItemDefinition {
  id: string;
  isRequired: boolean;
  isPccc: boolean;
}

export function validateChecklistSubmission(definitions: ChecklistItemDefinition[], results: ChecklistSubmissionItem[]): void {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.itemId)) throw new Error(`Duplicate checklist result ${result.itemId}`);
    seen.add(result.itemId);
    const definition = byId.get(result.itemId);
    if (!definition) throw new Error(`Checklist item ${result.itemId} is not part of the template`);
    if (result.status === 'FAIL' && result.severity === 'CRITICAL' && !definition.isPccc) {
      throw new Error(`Critical severity is restricted to PCCC checklist items: ${result.itemId}`);
    }
  }
  const missingRequired = definitions.filter((definition) => definition.isRequired && !seen.has(definition.id));
  if (missingRequired.length > 0) throw new Error(`Required checklist items are missing: ${missingRequired.map((item) => item.id).join(',')}`);
}

export function hasHighPriorityIncident(results: ChecklistSubmissionItem[]): boolean {
  return results.some((result) => result.status === 'FAIL' && result.severity === 'CRITICAL');
}
