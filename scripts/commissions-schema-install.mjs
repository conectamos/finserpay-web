const ATTEMPTS = 6;
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Run the complete transactional SQL unchanged; only confirmed lock conflicts can repeat it. */
export async function installCommissionSchema(client, sql, { sleep = sleepDefault, random = Math.random } = {}) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      await client.query(sql);
      return;
    } catch (error) {
      // Clear all locks from this failed transaction before waiting or repeating.
      // A broken connection or unconfirmed rollback cannot safely be reused.
      try {
        const rollback = await client.query("ROLLBACK");
        if (rollback?.command !== "ROLLBACK") throw error;
      } catch {
        throw error;
      }
      if ((error?.code !== "40P01" && error?.code !== "55P03") || attempt === ATTEMPTS - 1) throw error;
      await sleep(250 * (attempt + 1) + Math.floor(random() * 250));
    }
  }
}
