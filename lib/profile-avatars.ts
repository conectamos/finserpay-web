export const TIPOS_PERFIL_VISUAL = [
  "ADMINISTRADOR",
  "SUPERVISOR",
  "VENDEDOR",
] as const;

export type TipoPerfilVisual = (typeof TIPOS_PERFIL_VISUAL)[number];
export type TipoPerfilVendedor = Extract<TipoPerfilVisual, "SUPERVISOR" | "VENDEDOR">;

export const AVATAR_PERFIL_KEYS = [
  "ADMINISTRADOR_HOMBRE",
  "ADMINISTRADOR_MUJER",
  "SUPERVISOR",
  "SUPERVISORA_MUJER",
  "VENDEDOR_HOMBRE",
  "VENDEDOR_MUJER",
] as const;

export type AvatarPerfilKey = (typeof AVATAR_PERFIL_KEYS)[number];

type AvatarOption = {
  value: AvatarPerfilKey;
  label: string;
  src: string;
};

const AVATAR_OPTIONS_BY_TIPO: Record<TipoPerfilVisual, AvatarOption[]> = {
  ADMINISTRADOR: [
    {
      value: "ADMINISTRADOR_HOMBRE",
      label: "Administrador hombre",
      src: "/profile-avatars/administrador-hombre-3d.png",
    },
    {
      value: "ADMINISTRADOR_MUJER",
      label: "Administrador mujer",
      src: "/profile-avatars/administrador-mujer-3d.png",
    },
  ],
  SUPERVISOR: [
    {
      value: "SUPERVISOR",
      label: "Supervisor",
      src: "/profile-avatars/supervisor-3d.png",
    },
    {
      value: "SUPERVISORA_MUJER",
      label: "Supervisora mujer",
      src: "/profile-avatars/supervisora-mujer-3d.png",
    },
  ],
  VENDEDOR: [
    {
      value: "VENDEDOR_HOMBRE",
      label: "Vendedor hombre",
      src: "/profile-avatars/vendedor-hombre-3d.png",
    },
    {
      value: "VENDEDOR_MUJER",
      label: "Vendedor mujer",
      src: "/profile-avatars/vendedor-mujer-3d.png",
    },
  ],
};

export function normalizarTipoPerfilVendedor(valor: unknown): TipoPerfilVendedor {
  const tipo = String(valor || "").trim().toUpperCase().replace(/\s+/g, "_");
  return tipo === "SUPERVISOR" ? "SUPERVISOR" : "VENDEDOR";
}

export function obtenerOpcionesAvatarPorTipo(tipo: TipoPerfilVisual) {
  return AVATAR_OPTIONS_BY_TIPO[tipo];
}

export function obtenerAvatarDefaultPorTipo(tipo: TipoPerfilVisual): AvatarPerfilKey {
  return AVATAR_OPTIONS_BY_TIPO[tipo][0].value;
}

export function normalizarAvatarPerfil(
  valor: unknown,
  tipo: TipoPerfilVisual
): AvatarPerfilKey {
  const avatarKey = String(valor || "").trim().toUpperCase() as AvatarPerfilKey;
  const opciones = AVATAR_OPTIONS_BY_TIPO[tipo];

  return opciones.some((opcion) => opcion.value === avatarKey)
    ? avatarKey
    : obtenerAvatarDefaultPorTipo(tipo);
}

export function obtenerAvatarPerfilSrc(avatarKey: AvatarPerfilKey) {
  const option = TIPOS_PERFIL_VISUAL.flatMap((tipo) => AVATAR_OPTIONS_BY_TIPO[tipo])
    .find((item) => item.value === avatarKey);

  return option?.src || AVATAR_OPTIONS_BY_TIPO.VENDEDOR[0].src;
}

export function etiquetaAvatarPerfil(avatarKey: AvatarPerfilKey) {
  const option = TIPOS_PERFIL_VISUAL.flatMap((tipo) => AVATAR_OPTIONS_BY_TIPO[tipo])
    .find((item) => item.value === avatarKey);

  return option?.label || avatarKey;
}
