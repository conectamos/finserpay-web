export const creditWelcomeVoiceSchemaStatements: readonly string[];
export const creditWelcomeVoiceSingleCallCleanupStatements: readonly string[];
export function installCreditWelcomeVoiceSchema(client: { query(sql: string): Promise<unknown> }): Promise<{
  followupsStopped: number;
  campaignMembersStopped: number;
  pendingEventsCancelled: number;
  followupsRemaining: number;
  campaignMembersRemaining: number;
  pendingRetriesRemaining: number;
}>;
