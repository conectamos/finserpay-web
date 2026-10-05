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
  remission: {
    id: string;
    replacementId: string;
    version: number;
    status: "PENDING_UPLOAD" | "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
    photoSha256: string | null;
    requestedAt: string;
    uploadedAt: string | null;
    reviewedAt: string | null;
    uploadedByName: string | null;
  } | null;
  timeline: OperationalTimelineEvent[];
  capabilities: {
    /** A signed credit still in approval must use the pre-settlement workflow. */
    preSettlementApprovalCreditId: number | null;
    canChangeImei: boolean;
    canDispatchSignatureWithImei: boolean;
    canFinalizeImei: boolean;
    canConfirmReplacement: boolean;
    canUpdateContact: boolean;
    canSendSignature: boolean;
    canResendSignature: boolean;
    canRedirectPendingSignature: boolean;
    pendingSignatureRedirectReason: string | null;
    reason: string | null;
    signatureReason: string | null;
  };
};
