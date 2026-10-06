export type ApprovalAnalystAccountEventType =
  | "CREATED"
  | "ACTIVATED"
  | "DEACTIVATED"
  | "PASSWORD_RESET";

type AuditClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

type ApprovalAnalystAccountEvent = {
  analystUserId: number;
  actorUserId: number;
  eventType: ApprovalAnalystAccountEventType;
  accountActive: boolean | null;
};

export async function appendApprovalAnalystAccountEvent(
  db: AuditClient,
  event: ApprovalAnalystAccountEvent
) {
  if (!Number.isSafeInteger(event.analystUserId) || event.analystUserId < 1) {
    throw new Error("El analista de la auditoría es inválido.");
  }
  if (!Number.isSafeInteger(event.actorUserId) || event.actorUserId < 1) {
    throw new Error("El actor de la auditoría es inválido.");
  }

  const activeStateIsValid =
    (event.eventType === "CREATED" && typeof event.accountActive === "boolean") ||
    (event.eventType === "ACTIVATED" && event.accountActive === true) ||
    (event.eventType === "DEACTIVATED" && event.accountActive === false) ||
    (event.eventType === "PASSWORD_RESET" && event.accountActive === null);
  if (!activeStateIsValid) throw new Error("El estado de la auditoría es inválido.");

  const written = await db.$executeRawUnsafe(
    `INSERT INTO "ApprovalAnalystAccountEvent"
      ("analystUserId","actorUserId","eventType","accountActive")
      VALUES ($1,$2,$3,$4)`,
    event.analystUserId,
    event.actorUserId,
    event.eventType,
    event.accountActive
  );
  if (written !== 1) throw new Error("No se registró la auditoría de la cuenta del analista.");
}
