export type AnalystRequestDocument = {
  key: string;
  label: string;
  href: string | null;
  available: boolean;
  pdf: boolean;
};

export type AnalystRequestDetail = {
  id: string;
  source: "DRAFT" | "CREDIT";
  entityId: number;
  number: string;
  clientName: string;
  document: string | null;
  status: string;
  statusLabel: string;
  step: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  client: {
    phone: string | null;
    email: string | null;
    address: string | null;
    department: string | null;
    city: string | null;
    birthDate: string | null;
    documentType: string | null;
  };
  assignment: {
    ally: string | null;
    site: string | null;
    advisor: string | null;
    createdBy: string | null;
  };
  equipment: {
    reference: string | null;
    platform: string | null;
    imei: string | null;
  };
  financial: {
    saleValue: number | null;
    downPayment: number | null;
    authorizedAmount: number | null;
    installments: number | null;
    installment: number | null;
    frequency: string | null;
    firstPayment: string | null;
  };
  validations: Array<{ label: string; status: string | null }>;
  documents: AnalystRequestDocument[];
  timeline: Array<{
    id: string;
    label: string;
    status: string | null;
    at: string | null;
    detail: string | null;
    actor: string | null;
  }>;
  actions: Array<{
    kind: "imei" | "signature" | "release" | "approval";
    label: string;
    href: string;
  }>;
};
