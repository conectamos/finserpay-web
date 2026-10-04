export type OperationalCaseKind = "CREDIT" | "DRAFT";

export type OperationalCaseSummary = {
  kind: OperationalCaseKind;
  id: number;
  number: string;
  clientName: string;
  document: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  equipment: string;
  imei: string;
  updatedAt: string;
};

export type OperationalSignature = {
  status: "SIGNED" | "PENDING" | "TECHNICAL_ERROR" | "NOT_SENT";
  rawStatus: string | null;
  processUuid: string | null;
  sentPhone: string | null;
  sentEmail: string | null;
  sentAt: string | null;
  signedAt: string | null;
};

export type OperationalTimelineEvent = {
  id: string;
  at: string;
  label: string;
  detail: string | null;
  actor: string | null;
  status?: string | null;
  evidenceHref?: string | null;
};

export type OperationalCaseDetail = OperationalCaseSummary & {
  enrollmentReviewId: string | null;
  requiresEnrollmentReapproval: boolean;
  signature: OperationalSignature;
  pendingVersion: {
    id: string;
    status: string;
    replacementId: string | null;
    previousProcessUuid: string;
    newProcessUuid: string | null;
  } | null;
  replacement: {
    id: string;
    status: string;
    previousImei: string;
    newImei: string;
    reason: string;
    createdAt: string;
  } | null;
  timeline: OperationalTimelineEvent[];
  capabilities: {
    canChangeImei: boolean;
    canDispatchSignatureWithImei: boolean;
    canFinalizeImei: boolean;
    canConfirmReplacement: boolean;
    canUpdateContact: boolean;
    canResendSignature: boolean;
    reason: string | null;
  };
};
