"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";

type DashboardMonthSelectorProps = {
  currentMonth: string;
  label: string;
  selectedMonth: string;
};

const MIN_DASHBOARD_YEAR = 2000;
const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => {
  const label = new Intl.DateTimeFormat("es-CO", {
    month: "short",
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(2024, index, 1)))
    .replace(".", "");

  return label.charAt(0).toUpperCase() + label.slice(1);
});

function parseMonthKey(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);

  return match
    ? {
        month: Number(match[2]),
        year: Number(match[1]),
      }
    : null;
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export default function DashboardMonthSelector({
  currentMonth,
  label,
  selectedMonth,
}: DashboardMonthSelectorProps) {
  const router = useRouter();
  const selectorRef = useRef<HTMLDivElement>(null);
  const current = parseMonthKey(currentMonth) ?? { month: 1, year: MIN_DASHBOARD_YEAR };
  const selected = parseMonthKey(selectedMonth) ?? current;
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(selected.year);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!selectorRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function selectMonth(nextMonth: string) {
    setOpen(false);

    if (!nextMonth || nextMonth === selectedMonth) {
      return;
    }

    startTransition(() => {
      router.push(`/dashboard?month=${encodeURIComponent(nextMonth)}`, {
        scroll: false,
      });
    });
  }

  return (
    <div ref={selectorRef} className="relative">
      <button
        type="button"
        aria-busy={isPending}
        aria-controls="dashboard-month-menu"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex min-h-11 min-w-48 items-center gap-2 rounded-lg border border-[#d0d7e0] bg-white px-3 text-sm font-semibold text-[#344054] transition hover:border-[#98a2b3] focus-visible:border-[#78a016] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a3e635]/25 disabled:cursor-wait disabled:opacity-70"
        disabled={isPending}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <CalendarDays className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {isPending ? (
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition ${open ? "rotate-180" : ""}`}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
      </button>

      {open ? (
        <div
          id="dashboard-month-menu"
          role="dialog"
          aria-label="Seleccionar mes del dashboard"
          className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 shadow-[var(--fp-shadow-md)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--fp-border)] pb-3">
            <button
              type="button"
              aria-label="Año anterior"
              className="grid h-10 w-10 place-items-center rounded-md border border-[var(--fp-border)] text-[var(--fp-graphite)] transition hover:bg-[var(--fp-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]/35 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={visibleYear <= MIN_DASHBOARD_YEAR}
              onClick={() => setVisibleYear((year) => Math.max(MIN_DASHBOARD_YEAR, year - 1))}
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
            </button>
            <strong className="text-sm text-[var(--fp-graphite)]">{visibleYear}</strong>
            <button
              type="button"
              aria-label="Año siguiente"
              className="grid h-10 w-10 place-items-center rounded-md border border-[var(--fp-border)] text-[var(--fp-graphite)] transition hover:bg-[var(--fp-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]/35 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={visibleYear >= current.year}
              onClick={() => setVisibleYear((year) => Math.min(current.year, year + 1))}
            >
              <ChevronRight className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {MONTH_LABELS.map((monthLabel, index) => {
              const month = index + 1;
              const optionKey = monthKey(visibleYear, month);
              const isSelected = optionKey === selectedMonth;
              const isFutureMonth =
                visibleYear > current.year ||
                (visibleYear === current.year && month > current.month);

              return (
                <button
                  key={optionKey}
                  type="button"
                  aria-pressed={isSelected}
                  className={[
                    "min-h-10 rounded-md border px-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]/35 disabled:cursor-not-allowed disabled:opacity-35",
                    isSelected
                      ? "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]"
                      : "border-transparent text-[var(--fp-muted)] hover:border-[var(--fp-border)] hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)]",
                  ].join(" ")}
                  disabled={isFutureMonth}
                  onClick={() => selectMonth(optionKey)}
                >
                  {monthLabel}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
