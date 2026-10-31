import "server-only";
import { cookies } from "next/headers";

export const ATTENTION_PUSH_DEVICE_COOKIE = "finser-work-push-device";

type DeviceCookies = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: {
    path: string; httpOnly: boolean; secure: boolean; sameSite: "strict"; maxAge: number; expires: Date;
  }): unknown;
};
type DeviceDatabase = { $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown> };

// The opaque cookie identifies this browser's subscription only. Never revoke
// all devices for an account when a shared browser changes commercial profile.
export async function revokeAttentionPushDeviceWith(
  jar: DeviceCookies,
  database: () => Promise<DeviceDatabase>,
) {
  const id = jar.get(ATTENTION_PUSH_DEVICE_COOKIE)?.value;
  try {
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      await (await database()).$queryRawUnsafe(
        `DELETE FROM "AttentionPushSubscription" WHERE id=$1::uuid RETURNING id`, id,
      );
    }
  } catch {
    // A push-store outage must never prevent local logout. The browser also
    // unsubscribes on an explicit account/profile exit; delivery revalidates access.
  } finally {
    jar.set(ATTENTION_PUSH_DEVICE_COOKIE, "", {
      path: "/", httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "strict", maxAge: 0, expires: new Date(0),
    });
  }
}

export async function revokeAttentionPushDevice() {
  await revokeAttentionPushDeviceWith(await cookies(), async () => (await import("./prisma")).default);
}
