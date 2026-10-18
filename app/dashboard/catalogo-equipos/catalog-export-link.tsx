import { Download } from "lucide-react";

export default function CatalogExportLink({ product, query, status = "ACTIVOS" }: {
  product: "TODOS" | "ANDROID" | "IPHONE";
  query: string;
  status?: "ACTIVOS" | "RETIRADOS" | "TODOS";
}) {
  const params = new URLSearchParams({ product, status });
  if (query.trim()) params.set("q", query.trim());
  return (
    <a href={`/api/creditos/catalogo-equipos/exportar?${params}`} download className="fp-ui-button is-secondary">
      <Download size={18} aria-hidden="true" />
      Descargar Excel
    </a>
  );
}
