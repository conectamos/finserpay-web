type FinserBrandProps = {
  compact?: boolean;
  dark?: boolean;
  showTagline?: boolean;
};

export default function FinserBrand({
  compact = false,
  dark = false,
  showTagline = true,
}: FinserBrandProps) {
  const titleClass = dark ? "text-white" : "text-slate-950";
  const subtitleClass = dark ? "text-slate-300" : "text-slate-500";
  const iconShell = dark
    ? "border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_100%)] shadow-[0_18px_45px_rgba(15,23,42,0.22)]"
    : "border-[#d8dde5] bg-[linear-gradient(180deg,#ffffff_0%,#eef3f8_100%)] shadow-[0_18px_40px_rgba(15,23,42,0.10)]";

  return (
    <div className={["flex items-center", compact ? "gap-3" : "gap-4"].join(" ")}>
      <div
        className={[
          "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[24px] border",
          compact ? "h-14 w-14" : "h-16 w-16",
          iconShell,
        ].join(" ")}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.48),transparent_45%)]" />
        <svg
          viewBox="0 0 88 96"
          className={compact ? "h-10 w-10" : "h-12 w-12"}
          aria-hidden="true"
        >
          <path
            d="M44 6 L72 18 V45 C72 62 60 77 44 89 C28 77 16 62 16 45 V18 Z"
            fill="none"
            stroke="#D9E0E8"
            strokeWidth="5"
            strokeLinejoin="round"
          />
          <path
            d="M33 31 V24.5 C33 17.8 37.9 13 44 13 C50.1 13 55 17.8 55 24.5 V31"
            fill="none"
            stroke="#E9EEF4"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path
            d="M25 30 H60 L55 38 H40 V72 H31 V38 H25 Z"
            fill="#F2F6FA"
          />
          <path d="M40 46 H55 L50 54 H40 Z" fill="#DCE4EC" />
        </svg>
      </div>

      <div>
        <p
          className={[
            "font-black tracking-[0.08em]",
            compact ? "text-lg" : "text-2xl",
            titleClass,
          ].join(" ")}
          style={{ fontFamily: '"Arial Black", "Trebuchet MS", sans-serif' }}
        >
          FINSER PAY
        </p>
        {showTagline && (
          <p className={["mt-1 text-sm", subtitleClass].join(" ")}>
            Innovacion financiera con confianza
          </p>
        )}
      </div>
    </div>
  );
}
