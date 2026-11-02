import { createDianaExtensionHandler } from "@/lib/diana-extension-api";
import { dianaExtensionRuntime, dianaExtensionsEnabled } from "@/lib/diana-extension-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = createDianaExtensionHandler({
  token: () => process.env.FINSERPAY_DIANA_EXTENSION_API_TOKEN,
  enabled: () => dianaExtensionsEnabled(),
  propose: async input => (await dianaExtensionRuntime()).store.propose(input),
  status: async code => {
    const { store } = await dianaExtensionRuntime();
    // Let the durable event worker validate a just-received confirmation. This
    // only reads the ledger; neither the action nor the model can approve it.
    const deadline = Date.now() + 15000;
    let result = await store.status(code);
    while (["PENDING", "OFFERED"].includes(result.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      result = await store.status(code);
    }
    return result;
  },
});
