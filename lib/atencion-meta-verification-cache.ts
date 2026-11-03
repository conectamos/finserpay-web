import "server-only";

export type AttentionVerifiedMetaConnection = { phoneNumberId: string; wabaId: string; displayPhone: string };

/** Only provider identity checks are reused. Permissions, message contents and
 * customer data never enter this process-local, short-lived cache. */
export function createAttentionMetaVerificationCache({ ttlMs = 5_000, limit = 8 }: { ttlMs?: number; limit?: number } = {}) {
  const lifetime = Number.isFinite(ttlMs) ? Math.max(0, Math.min(ttlMs, 5_000)) : 5_000;
  const capacity = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 8)) : 8;
  type Entry = { checkedAt?: number; value?: AttentionVerifiedMetaConnection; pending?: Promise<AttentionVerifiedMetaConnection> };
  const entries = new Map<string, Entry>();
  return {
    async verify(key: string, now: () => number, read: () => Promise<AttentionVerifiedMetaConnection>): Promise<AttentionVerifiedMetaConnection> {
      const instant = now();
      const existing = entries.get(key);
      if (existing?.value && existing.checkedAt !== undefined && instant >= existing.checkedAt && instant - existing.checkedAt < lifetime) {
        entries.delete(key); entries.set(key, existing);
        return { ...existing.value };
      }
      if (existing?.pending) return { ...await existing.pending };
      if (existing) entries.delete(key);
      while (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      const entry: Entry = {};
      entries.set(key, entry);
      const pending = read().then(value => {
        if (entries.get(key) === entry) { entry.value = { ...value }; entry.checkedAt = now(); delete entry.pending; }
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entry.pending = pending;
      return { ...await pending };
    },
  };
}

/** Default adapters share only successful checks for an identical private
 * configuration. Injected transports get isolated caches unless opted in. */
export const sharedAttentionMetaVerificationCache = createAttentionMetaVerificationCache();
