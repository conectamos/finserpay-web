export const cuotaVencidaWhatsAppSchemaStatements: string[];
export const bloqueoWhatsAppSchemaStatements: string[];
export function installCuotaVencidaWhatsAppSchema(client: { query(query: string, values?: unknown[]): Promise<unknown> }, campaign?: "CUOTAVENCIDA" | "BLOQUEO"): Promise<void>;
