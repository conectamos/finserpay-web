import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { PageHeader } from "@/app/_components/finser-ui";
import CreditFactoryConsole from "./credit-factory-console";
import CreditPlatformSelector from "./credit-platform-selector";
import { ApprovedCreditEvidenceCorrection } from "./credit-evidence-gallery";

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
  returnTo?: string;
}>;
type EntryMode = "default" | "create-client" | "delivery" | "simulator";
type DevicePlatform = "android" | "iphone";

function solicitudesReturnHref(value: string | undefined) {
  const candidate = String(value || "").trim();
  return candidate === "/dashboard/solicitudes" ||
    candidate.startsWith("/dashboard/solicitudes?")
    ? candidate
    : "/dashboard/solicitudes";
}

export default async function CreditosPage(props: {
  searchParams: SearchParams;
}) {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const admin = isAdminRole(session.rolNombre);
  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const sellerSession = admin ? null : await getSellerSessionUser(session);

  if (!admin && !sellerSession) {
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
  const returnTo = solicitudesReturnHref(searchParams?.returnTo);

  if (rawEntryMode === "correction") {
    if (
      !adminCentral ||
      !Number.isInteger(initialSelectedId) ||
      initialSelectedId <= 0
    ) {
      redirect("/dashboard/solicitudes");
    }

    return (
      <div className="mx-auto w-full max-w-[1600px]">
        <PageHeader
          eyebrow="Fábrica de créditos"
          title="Corrección de venta aprobada"
          description="Reemplaza únicamente evidencias de la venta. Los datos comerciales, el estado y las validaciones externas permanecen intactos."
          actions={
            <Link
              href={returnTo}
              className="fp-ui-button is-secondary min-h-11"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Volver al muro
            </Link>
          }
        />
        <div className="mb-4 flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-white p-4 text-sm text-[var(--fp-muted)]">
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]"
            aria-hidden="true"
          />
          <p>
            Este acceso es exclusivo del administrador central FINSER PAY. Cada
            reemplazo registra actor, fecha y huellas de la evidencia anterior y
            nueva.
          </p>
        </div>
        <ApprovedCreditEvidenceCorrection
          creditId={initialSelectedId}
          clientName={`Crédito ${initialSelectedId}`}
        />
      </div>
    );
  }

  const hasSelectedCredit =
    Number.isInteger(initialSelectedId) && initialSelectedId > 0;

  if (!adminCentral && (rawEntryMode === "delivery" || hasSelectedCredit)) {
    redirect("/dashboard/solicitudes");
  }

  let requestedEntryMode: EntryMode = "default";

  if (
    rawEntryMode === "create-client" ||
    rawEntryMode === "delivery" ||
    rawEntryMode === "simulator"
  ) {
    requestedEntryMode = rawEntryMode;
  }

  const advisorSession =
    !admin && sellerSession?.tipoPerfil !== "SUPERVISOR";
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
    (entryMode === "create-client" || entryMode === "simulator") &&
    !devicePlatform &&
    !(Number.isInteger(initialDraftId) && initialDraftId > 0);

  if (
    sellerSession?.tipoPerfil === "SUPERVISOR" &&
    !["create-client", "simulator"].includes(entryMode)
  ) {
    redirect("/dashboard");
  }

  if (
    (admin || sellerSession?.tipoPerfil === "SUPERVISOR") &&
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

  if (shouldChooseDevicePlatform) {
    const buildPlatformHref = (platform: DevicePlatform) => {
      const params = new URLSearchParams();
      params.set("mode", entryMode);
      params.set("platform", platform);

      if (initialSearch) {
        params.set("search", initialSearch);
      }

      if (Number.isInteger(initialSelectedId) && initialSelectedId > 0) {
        params.set("selected", String(initialSelectedId));
      }

      return `/dashboard/creditos?${params.toString()}`;
    };

    return (
      <CreditPlatformSelector
        admin={admin}
        adminCentral={adminCentral}
        androidHref={buildPlatformHref("android")}
        iphoneHref={buildPlatformHref("iphone")}
        mode={entryMode === "simulator" ? "simulator" : "sale"}
        nombreUsuario={session.nombre}
        rolUsuario={session.rolNombre}
        sedeNombre={sellerSession?.sedeNombre || session.sedeNombre}
      />
    );
  }

  return (
    <CreditFactoryConsole
      key={`${entryMode}:${devicePlatform || "sin-plataforma"}:${Number.isInteger(initialDraftId) && initialDraftId > 0 ? initialDraftId : "nuevo"}`}
      initialSession={session}
      initialSeller={sellerSession}
      initialSearch={initialSearch}
      initialSelectedId={Number.isInteger(initialSelectedId) && initialSelectedId > 0 ? initialSelectedId : null}
      initialDraftId={Number.isInteger(initialDraftId) && initialDraftId > 0 ? initialDraftId : null}
      entryMode={entryMode}
      devicePlatform={devicePlatform}
      chooseDevicePlatform={false}
    />
  );
}
