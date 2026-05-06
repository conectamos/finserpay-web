import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/clientes",
    name: "FINSER PAY Clientes",
    short_name: "FINSER PAY",
    description: "Consulta de cuotas, estado de credito y pagos en linea.",
    lang: "es-CO",
    start_url: "/clientes",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111317",
    theme_color: "#111317",
    categories: ["finance", "business"],
    icons: [
      {
        src: "/icons/finserpay-client-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/finserpay-client-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/finserpay-client-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Consultar credito",
        short_name: "Consultar",
        description: "Abrir el portal de clientes",
        url: "/clientes",
        icons: [
          {
            src: "/icons/finserpay-client-192.png",
            sizes: "192x192",
          },
        ],
      },
    ],
  };
}
