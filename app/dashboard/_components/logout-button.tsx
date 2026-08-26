"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

type LogoutButtonProps = {
  className?: string;
  showIcon?: boolean;
};

export default function LogoutButton({
  className = "",
  showIcon = false,
}: LogoutButtonProps) {
  const router = useRouter();
  const [cerrando, setCerrando] = useState(false);

  const cerrarSesion = async () => {
    try {
      setCerrando(true);

      const res = await fetch("/api/logout", {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error("No se pudo cerrar la sesion");
      }

      router.replace("/");
      router.refresh();
    } catch {
      setCerrando(false);
      window.alert("No se pudo cerrar la sesion. Intenta de nuevo.");
    }
  };

  return (
    <button
      type="button"
      onClick={cerrarSesion}
      disabled={cerrando}
      className={[
        "inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white backdrop-blur transition hover:border-white/25 hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-70",
        className,
      ].join(" ")}
    >
      {showIcon && !cerrando ? (
        <LogOut className="mr-2 h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
      ) : null}
      {cerrando ? "Cerrando..." : "Cerrar sesion"}
    </button>
  );
}
