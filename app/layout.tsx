import type { Metadata, Viewport } from "next";
import PwaRegister from "@/app/_components/pwa-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "FINSER PAY",
  description: "Portal financiero para creditos e integraciones Zero Touch",
  applicationName: "FINSER PAY Clientes",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "FINSER PAY",
  },
  icons: {
    icon: [
      {
        url: "/icons/finserpay-client-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        url: "/icons/finserpay-client-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#145a5a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
