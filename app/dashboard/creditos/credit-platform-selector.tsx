import NewSalePlatformSelector from "./new-sale-platform-selector";

type CreditPlatformSelectorProps = {
  admin: boolean;
  adminCentral: boolean;
  isSupervisor?: boolean;
  androidHref: string;
  iphoneHref: string;
  mode?: "sale" | "simulator";
  nombreUsuario: string;
  rolUsuario: string;
  sedeNombre: string;
};

export default function CreditPlatformSelector(props: CreditPlatformSelectorProps) {
  return <NewSalePlatformSelector {...props} />;
}
