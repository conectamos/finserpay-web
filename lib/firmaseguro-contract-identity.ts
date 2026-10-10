import { readFirmaSeguroFullNameIdentity } from "@/lib/datacredito/firmaseguro-identity";

type ContractCredit = {
  clienteNombre: string;
  clienteDocumento?: string | null;
  contratoSnapshot?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function canonicalBinding(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase();
}

/** New signing records freeze the provider identity; legacy documents keep their original name. */
export function readFirmaSeguroContractIdentity(credit: ContractCredit) {
  const snapshot = record(credit.contratoSnapshot);
  if (snapshot.firmaSeguroContractNameVersion !== 1) return null;
  const metadata = record(snapshot.firmaSeguroIdentity);
  const effective = record(record(snapshot.dataCreditoIdentity).effective);
  const canonical = effective.fullName ?? metadata.canonicalFullName;
  if (typeof canonical !== "string" || !canonical.trim() ||
      canonicalBinding(credit.clienteNombre) !== canonicalBinding(canonical)) {
    throw new Error("FIRMASEGURO_CONTRACT_IDENTITY_BINDING_INVALID");
  }
  return readFirmaSeguroFullNameIdentity(metadata, {
    fullName: canonical, documentNumber: credit.clienteDocumento || "",
  });
}

/** A rendering-only copy keeps the DataCrédito identity and financial seal unchanged. */
export function projectFirmaSeguroContractIdentity<T extends ContractCredit>(credit: T): T {
  const identity = readFirmaSeguroContractIdentity(credit);
  if (!identity) return credit;
  return { ...credit, clienteNombre: [identity.firstName, identity.secondName,
    identity.firstLastName, identity.secondLastName].filter(Boolean).join(" ") };
}
