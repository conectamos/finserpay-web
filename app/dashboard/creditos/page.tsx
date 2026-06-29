import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import CreditFactoryConsole from "./credit-factory-console";

export const metadata = {
  title: "Fabrica de creditos | FINSER PAY",
  description: "Flujo operativo para generar creditos, inscribir equipos y validar entregabilidad",
};

type SearchParams = Promise<{
  search?: string;
  mode?: string;
  selected?: string;
  draft?: string;
  platform?: string;
}>;
type EntryMode = "default" | "create-client" | "delivery" | "simulator";
type DevicePlatform = "android" | "iphone";

export default async function CreditosPage(props: {
  searchParams: SearchParams;
}) {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const sellerSession = isAdminRole(session.rolNombre)
    ? null
    : await getSellerSessionUser(session);

  if (!isAdminRole(session.rolNombre) && !sellerSession) {
    redirect("/dashboard");
  }

  const searchParams = await props.searchParams;
  const initialSearch = String(searchParams?.search || "").trim();
  const initialSelectedId = Number(searchParams?.selected || 0);
  const initialDraftId = Number(searchParams?.draft || 0);
  const rawDevicePlatform = String(searchParams?.platform || "").trim().toLowerCase();
  const devicePlatform: DevicePlatform | null =
    rawDevicePlatform === "android" || rawDevicePlatform === "iphone"
      ? rawDevicePlatform
      : null;
  const rawEntryMode = String(searchParams?.mode || "").trim().toLowerCase();
  let requestedEntryMode: EntryMode = "default";

  if (
    rawEntryMode === "create-client" ||
    rawEntryMode === "delivery" ||
    rawEntryMode === "simulator"
  ) {
    requestedEntryMode = rawEntryMode;
  }

  const advisorSession =
    !isAdminRole(session.rolNombre) && sellerSession?.tipoPerfil !== "SUPERVISOR";
  const hasDirectCreditIntent =
    Boolean(initialSearch) ||
    (Number.isInteger(initialSelectedId) && initialSelectedId > 0) ||
    (Number.isInteger(initialDraftId) && initialDraftId > 0);
  const entryMode: EntryMode = advisorSession
    ? requestedEntryMode === "delivery" || requestedEntryMode === "simulator"
      ? requestedEntryMode
      : "create-client"
    : requestedEntryMode === "default" && !hasDirectCreditIntent
      ? "create-client"
      : requestedEntryMode;
  const shouldChooseDevicePlatform =
    entryMode === "create-client" &&
    !devicePlatform &&
    !(Number.isInteger(initialDraftId) && initialDraftId > 0);

  if (
    sellerSession?.tipoPerfil === "SUPERVISOR" &&
    !["create-client", "simulator"].includes(entryMode)
  ) {
    redirect("/dashboard");
  }

  if (
    (isAdminRole(session.rolNombre) || sellerSession?.tipoPerfil === "SUPERVISOR") &&
    (initialSearch || (Number.isInteger(initialSelectedId) && initialSelectedId > 0)) &&
    !(Number.isInteger(initialDraftId) && initialDraftId > 0) &&
    entryMode !== "create-client"
  ) {
    const params = new URLSearchParams();

    if (initialSearch) {
      params.set("search", initialSearch);
    }

    if (Number.isInteger(initialSelectedId) && initialSelectedId > 0) {
      params.set("selected", String(initialSelectedId));
    }

    redirect(`/dashboard/clientes${params.size ? `?${params.toString()}` : ""}`);
  }

  return (
    <CreditFactoryConsole
      key={`${entryMode}:${Number.isInteger(initialDraftId) && initialDraftId > 0 ? initialDraftId : "nuevo"}`}
      initialSession={session}
      initialSeller={sellerSession}
      initialSearch={initialSearch}
      initialSelectedId={Number.isInteger(initialSelectedId) && initialSelectedId > 0 ? initialSelectedId : null}
      initialDraftId={Number.isInteger(initialDraftId) && initialDraftId > 0 ? initialDraftId : null}
      entryMode={entryMode}
      devicePlatform={devicePlatform}
      chooseDevicePlatform={shouldChooseDevicePlatform}
    />
  );
}
