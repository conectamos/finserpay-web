"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronDown, LoaderCircle } from "lucide-react";

type DashboardMonthSelectorProps = {
  currentMonth: string;
  label: string;
  selectedMonth: string;
};

export default function DashboardMonthSelector({
  currentMonth,
  label,
  selectedMonth,
}: DashboardMonthSelectorProps) {
  const router = useRouter();
  const [value, setValue] = useState(selectedMonth);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setValue(selectedMonth);
  }, [selectedMonth]);

  function selectMonth(nextMonth: string) {
    if (!nextMonth || nextMonth === selectedMonth) {
      return;
    }

    setValue(nextMonth);
    startTransition(() => {
      router.push(`/dashboard?month=${encodeURIComponent(nextMonth)}`, {
        scroll: false,
      });
    });
  }

  return (
    <label
      className="relative inline-flex min-h-11 min-w-48 items-center gap-2 rounded-lg border border-[#d0d7e0] bg-white px-3 text-sm font-semibold text-[#344054] transition hover:border-[#98a2b3] focus-within:border-[#78a016] focus-within:ring-2 focus-within:ring-[#a3e635]/25"
      aria-busy={isPending}
    >
      <CalendarDays className="h-5 w-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {isPending ? (
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <ChevronDown className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      )}
      <input
        aria-label="Mes del dashboard"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
        disabled={isPending}
        max={currentMonth}
        min="2000-01"
        onChange={(event) => selectMonth(event.currentTarget.value)}
        type="month"
        value={value}
      />
    </label>
  );
}
