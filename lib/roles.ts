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
};

export function canReviewCreditApprovals(user: ApprovalAccessUser | null | undefined) {
  return Boolean(
    user && user.activo !== false &&
    String(user.aliadoAccesoCodigo || "").trim().toUpperCase() === "FINSERPAY" &&
    (isAdminRole(user.rolNombre) || isApprovalAnalystRole(user.rolNombre))
  );
}

export function canManageApprovalAnalysts(user: ApprovalAccessUser | null | undefined) {
  return canReviewCreditApprovals(user) && isAdminRole(user?.rolNombre);
}
