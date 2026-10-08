export const creditWelcomeVoiceSchemaStatements: readonly string[];
export function installCreditWelcomeVoiceSchema(client: { query(sql: string): Promise<unknown> }): Promise<void>;
