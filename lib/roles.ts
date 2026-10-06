export function isAdminRole(roleName: string | null | undefined) {
  return String(roleName || "").trim().toUpperCase() === "ADMIN";
}

export function isSellerRole(roleName: string | null | undefined) {
  return !isAdminRole(roleName) && !isApprovalAnalystRole(roleName);
}

export const APPROVAL_ANALYST_ROLE = "ANALISTA_APROBACION";

export function isApprovalAnalystRole(roleName: string | null | undefined) {
  return String(roleName || "").trim().toUpperCase() === APPROVAL_ANALYST_ROLE;
}

type ApprovalAccessUser = {
  activo?: boolean;
  rolNombre?: string | null;
  aliadoAccesoCodigo?: string | null;
  sedeAccesoActiva?: boolean;
  aliadoAccesoActivo?: boolean;
};

export function canReviewCreditApprovals(user: ApprovalAccessUser | null | undefined) {
  if (
    !user ||
    user.activo === false ||
    String(user.aliadoAccesoCodigo || "").trim().toUpperCase() !== "FINSERPAY"
  ) return false;

  if (isAdminRole(user.rolNombre)) return true;

  return Boolean(
    isApprovalAnalystRole(user.rolNombre) &&
    user.sedeAccesoActiva === true &&
    user.aliadoAccesoActivo === true
  );
}

export function canManageApprovalAnalysts(user: ApprovalAccessUser | null | undefined) {
  return canReviewCreditApprovals(user) && isAdminRole(user?.rolNombre);
}
