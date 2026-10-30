/** Public template data: no Meta identifiers, credentials or media URLs. */
export type AttentionTemplateParameter = { key: string; label: string; maxLength: number };
export type AttentionTemplateFinancialCandidate = {
  creditId: number; creditLabel: string; revision: string | null; parameters: Record<string,string>;
  eligible: boolean; reason: string | null; installmentNumber: number | null; dueDate: string | null;
  checkedOn: string | null; pendingAmount?: number | null;
  coveredCredits?: {id:number;number:string}[];
};
export type AttentionTemplate = {
  key: string; name: string; language: string; category: string; revision: string;
  header: string | null; body: string; footer: string | null;
  buttons: { type: string; text: string; url?: string }[];
  parameters: AttentionTemplateParameter[]; available: boolean; reason: string | null;
  headerImageUrl?: string | null;
  financial?: { candidates: AttentionTemplateFinancialCandidate[]; blockedReason: string | null };
};
export type AttentionTemplateCatalogue = {
  templates: AttentionTemplate[]; canSend: boolean; reason: string | null;
  conversationVersion: number; requiresBindingConfirmation: boolean;
};
export type AttentionTemplateIntent = {
  requestId: string; version: number; templateKey: string; revision: string;
  parameters: Record<string, string>; confirmed: true;
  creditId?: number; financialRevision?: string;
};

export function renderAttentionTemplatePreview(template: AttentionTemplate, parameters: Record<string, string>): string {
  const render=(value:string,component:string)=>value.replace(/\{\{([a-z_]+|[1-9]\d*)\}\}/g,(match,token)=>parameters[`${component}:${token}`] ?? match);
  return [render(template.header||"","header"),render(template.body,"body"),template.footer,
    ...template.buttons.map((button,index)=>button.url ? `${button.text}: ${button.url.replace("{{1}}",parameters[`button:${index}`] ?? "{{1}}")}` : button.text)].filter(Boolean).join("\n");
}
