import type { ComponentPropsWithoutRef } from "react";
import {
  buildFinserPaySupportHref,
  FINSER_PAY_SUPPORT,
} from "@/lib/support";

type FinserSupportLinkProps = Omit<
  ComponentPropsWithoutRef<"a">,
  "aria-label" | "href" | "rel" | "target"
> & {
  supportAriaLabel?: string;
  supportMessage?: string;
};

export default function FinserSupportLink({
  children,
  supportAriaLabel,
  supportMessage,
  ...props
}: FinserSupportLinkProps) {
  return (
    <a
      {...props}
      href={
        supportMessage
          ? buildFinserPaySupportHref(supportMessage)
          : FINSER_PAY_SUPPORT.href
      }
      target={FINSER_PAY_SUPPORT.target}
      rel={FINSER_PAY_SUPPORT.rel}
      aria-label={supportAriaLabel || FINSER_PAY_SUPPORT.ariaLabel}
    >
      {children}
    </a>
  );
}
