export function isAdminRole(roleName: string | null | undefined) {
  return String(roleName || "").trim().toUpperCase() === "ADMIN";
}

export function isSellerRole(roleName: string | null | undefined) {
  return !isAdminRole(roleName);
}
