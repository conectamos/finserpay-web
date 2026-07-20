import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { obtenerAvatarPerfilSrc } from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import {
  getCurrentBogotaMonthRange,
  getTodayBogotaRange,
} from "@/lib/ventas-utils";
import SellerProfileAccess from "./_components/seller-profile-access";
import AdminCentralDashboard from "./_components/admin-central-dashboard";
import SellerCommercialDashboard from "./_components/seller-commercial-dashboard";
import { getAdminDashboardOverview } from "./_lib/admin-dashboard-data";

export default async function DashboardPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const usuario = await prisma.usuario.findUnique({
    where: { id: session.id },
    include: {
      rol: true,
      sede: true,
    },
  });

  const nombreUsuario = usuario?.nombre ?? "Usuario";
  const rolUsuario = usuario?.rol?.nombre ?? "USUARIO";
  const sedeAccesoLabel = usuario?.sede?.nombre ?? "GLOBAL";
  const admin = isAdminRole(rolUsuario);
  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const adminAliado = admin && !adminCentral;
  const aliadoPanelNombre = session.aliadoAccesoNombre || "Aliado";
  const aliadoScopeId = Number(session.aliadoAccesoId || 0);
  const aliadoStatsScopeId =
    Number.isInteger(aliadoScopeId) && aliadoScopeId > 0 ? aliadoScopeId : -1;

  if (!admin) {
    await ensureVendorProfileVisualColumns();
  }

  const sellerSession = admin ? null : await getSellerSessionUser(session);
  const sedeLabel = sellerSession?.sedeNombre ?? session.sedeNombre ?? sedeAccesoLabel;
  const assignedSellers = admin
    ? []
    : await prisma.sedeVendedor.findMany({
        where: {
          sedeId: session.sedeAccesoId ?? session.sedeId,
          activo: true,
          vendedor: {
            activo: true,
          },
        },
        select: {
          vendedor: {
            select: {
              id: true,
              nombre: true,
              documento: true,
              telefono: true,
              email: true,
              tipoPerfil: true,
              avatarKey: true,
              debeCambiarPin: true,
            },
          },
        },
        orderBy: {
          vendedor: {
            nombre: "asc",
          },
        },
      });

  if (admin) {
    await ensureCreditAbonoAuditColumns();
  }

  if (!admin && !sellerSession) {
    return (
      <SellerProfileAccess
        sedeNombre={sedeAccesoLabel}
        sellers={assignedSellers.map((item) => item.vendedor)}
      />
    );
  }

  if (!admin && sellerSession) {
    const sellerIsSupervisor = sellerSession.tipoPerfil === "SUPERVISOR";
    const sellerAvatarSrc = obtenerAvatarPerfilSrc(sellerSession.avatarKey);
    const today = getTodayBogotaRange();
    const month = getCurrentBogotaMonthRange();
    const creditoScope = sellerIsSupervisor
      ? { sedeId: sellerSession.sedeId }
      : { vendedorId: sellerSession.id };
    const abonoScope = sellerIsSupervisor
      ? { sedeId: sellerSession.sedeId }
      : { vendedorId: sellerSession.id };

    const [
      creditosHoy,
      creditosMes,
      creditosActivos,
      pendientesEntrega,
      abonosHoy,
      recentCredits,
    ] = await Promise.all([
      prisma.credito.count({
        where: {
          ...creditoScope,
          estado: { not: "ANULADO" },
          fechaCredito: { gte: today.start, lt: today.end },
        },
      }),
      prisma.credito.count({
        where: {
          ...creditoScope,
          estado: { not: "ANULADO" },
          fechaCredito: { gte: month.start, lt: month.end },
        },
      }),
      prisma.credito.count({
        where: {
          ...creditoScope,
          estado: { not: "ANULADO" },
        },
      }),
      prisma.credito.count({
        where: {
          ...creditoScope,
          estado: { not: "ANULADO" },
          deliverableReady: false,
        },
      }),
      prisma.creditoAbono.aggregate({
        where: {
          ...abonoScope,
          estado: { not: "ANULADO" },
          fechaAbono: { gte: today.start, lt: today.end },
        },
        _sum: { valor: true },
      }),
      prisma.credito.findMany({
        where: {
          ...creditoScope,
          estado: { not: "ANULADO" },
        },
        orderBy: { fechaCredito: "desc" },
        take: 5,
        select: {
          id: true,
          clienteNombre: true,
          folio: true,
          referenciaEquipo: true,
          equipoMarca: true,
          equipoModelo: true,
          imei: true,
          estado: true,
          deliverableReady: true,
          fechaCredito: true,
        },
      }),
    ]);

    return (
      <SellerCommercialDashboard
        avatarSrc={sellerAvatarSrc}
        debeCambiarPin={sellerSession.debeCambiarPin}
        isSupervisor={sellerIsSupervisor}
        nombre={sellerSession.nombre}
        sedeNombre={sedeLabel}
        stats={{
          abonosHoy: Number(abonosHoy._sum.valor || 0),
          creditosActivos,
          creditosHoy,
          creditosMes,
          pendientesEntrega,
        }}
        recentCredits={recentCredits.map((credit) => ({
          clienteNombre: credit.clienteNombre,
          equipo:
            credit.referenciaEquipo ||
            [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" ") ||
            credit.imei,
          estado: credit.estado,
          fecha: credit.fechaCredito.toISOString(),
          folio: credit.folio,
          id: credit.id,
          listoEntrega: credit.deliverableReady,
        }))}
      />
    );
  }

  const dashboardOverview = await getAdminDashboardOverview({
    aliadoId: adminAliado ? aliadoStatsScopeId : null,
  });

  return (
    <AdminCentralDashboard
      adminCentral={adminCentral}
      aliadoNombre={aliadoPanelNombre}
      data={dashboardOverview}
      nombreUsuario={nombreUsuario}
      rolUsuario={rolUsuario}
      sedeLabel={sedeLabel}
    />
  );
}
