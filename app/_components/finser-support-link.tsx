import type { ComponentPropsWithoutRef } from "react";
import { FINSER_PAY_SUPPORT } from "@/lib/support";

type FinserSupportLinkProps = Omit<
  ComponentPropsWithoutRef<"a">,
  "aria-label" | "href" | "rel" | "target"
>;

export default function FinserSupportLink({
  children,
  ...props
}: FinserSupportLinkProps) {
  return (
    <a
      {...props}
      href={FINSER_PAY_SUPPORT.href}
      target={FINSER_PAY_SUPPORT.target}
      rel={FINSER_PAY_SUPPORT.rel}
      aria-label={FINSER_PAY_SUPPORT.ariaLabel}
    >
      {children}
    </a>
  );
}
