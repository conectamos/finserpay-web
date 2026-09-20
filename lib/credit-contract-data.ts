import { readFinancingTermsSeal } from "@/lib/credit-amortization-contract";
import { formatApprovalEquipmentReference } from "@/lib/credit-approval-data-core";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function storedString(source: Record<string, unknown>, key: string, fallback: unknown) {
  return typeof source[key] === "string" ? source[key] as string : fallback;
}

/**
 * Legal documents generated after an operational correction must keep the
 * client and equipment values that were frozen when the contract was signed.
 */
export function withContractualCreditData<T extends Record<string, unknown>>(credit: T): T {
  const snapshot = record(credit.contratoSnapshot);
  const client = record(snapshot.cliente);
  const equipment = record(snapshot.equipo);
  const financial = record(snapshot.financiero);
  const seal = readFinancingTermsSeal(financial.selloFinanciero);
  const terms = seal?.snapshot;
  const contractualBrand = terms?.equipoMarca ?? storedString(equipment, "marca", credit.equipoMarca);
  const contractualModel = terms?.equipoModelo ?? storedString(equipment, "modelo", credit.equipoModelo);
  const fallbackReference = formatApprovalEquipmentReference(contractualBrand, contractualModel);
  return {
    ...credit,
    clienteCorreo: terms?.clienteCorreo ?? storedString(client, "correo", credit.clienteCorreo),
    clienteTelefono: terms?.clienteTelefono ?? storedString(client, "telefono", credit.clienteTelefono),
    clienteDepartamento: storedString(client, "departamento", credit.clienteDepartamento),
    clienteCiudad: storedString(client, "ciudad", credit.clienteCiudad),
    clienteDireccion: terms?.clienteDireccion ?? storedString(client, "direccion", credit.clienteDireccion),
    referenciaEquipo: terms?.referenciaEquipo || fallbackReference || credit.referenciaEquipo,
  };
}
