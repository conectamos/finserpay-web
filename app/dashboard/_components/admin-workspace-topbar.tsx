import Link from "next/link";
import { Bell, ChevronRight, CircleHelp, Home } from "lucide-react";
import FinserSupportLink from "@/app/_components/finser-support-link";

function initials(value: string) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return (parts[0]?.[0] || "F") + (parts[1]?.[0] || parts[0]?.[1] || "P");
}

export default function AdminWorkspaceTopbar({
  current,
  parent,
  userName,
  userRole,
  accentAvatar = false,
}: {
  current: string;
  parent: string;
  userName: string;
  userRole: string;
  accentAvatar?: boolean;
}) {
  return (
    <header className="fp-workspace-topbar">
      <nav className="flex min-w-0 items-center gap-2 text-sm text-[#667085]" aria-label="Ruta actual">
        <Link
          href="/dashboard"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[#344054] transition hover:bg-[#f2f4f7]"
          aria-label="Ir al panel central"
        >
          <Home className="h-4 w-4" strokeWidth={1.9} />
        </Link>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#98a2b3]" strokeWidth={1.7} />
        <span className="truncate">{parent}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#98a2b3]" strokeWidth={1.7} />
        <strong className="truncate text-[#151a21]">{current}</strong>
      </nav>

      <div className="flex items-center gap-3 sm:gap-5">
        <FinserSupportLink className="hidden min-h-11 items-center gap-2 rounded-md px-2 text-sm font-semibold text-[#475467] transition hover:bg-[#f2f4f7] hover:text-[#151a21] xl:inline-flex">
          <CircleHelp className="h-5 w-5" strokeWidth={1.8} />
          Ayuda
        </FinserSupportLink>
        <span className="hidden h-7 w-px bg-[#e4e7ec] sm:block" aria-hidden="true" />
        <span className="grid h-9 w-9 place-items-center rounded-full text-[#151a21]" aria-label="Notificaciones">
          <Bell className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <span
          className={[
            "grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-black uppercase",
            accentAvatar ? "bg-[#dafa70] text-[#26330c]" : "bg-[#0b2030] text-white",
          ].join(" ")}
        >
          {initials(userName)}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-44 truncate text-sm font-bold text-[#151a21]">{userName}</span>
          <span className="mt-0.5 block text-[11px] font-semibold uppercase text-[#667085]">{userRole}</span>
        </span>
      </div>
    </header>
  );
}
