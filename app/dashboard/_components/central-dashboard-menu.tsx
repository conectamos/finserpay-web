"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./admin-central-dashboard.module.css";

export default function CentralDashboardMenu({ label, summaryClassName, children }: {
    label: ReactNode;
    summaryClassName?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        const closeOutside = (event: PointerEvent) => {
            if (event.target instanceof Node && !ref.current?.contains(event.target) && ref.current) ref.current.open = false;
        };
        const closeEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape" && ref.current?.open) {
                ref.current.open = false;
                ref.current.querySelector("summary")?.focus();
            }
        };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            document.removeEventListener("keydown", closeEscape);
        };
    }, []);
    return <details ref={ref} name="finser-central-navigation" className={styles.menu}>
        <summary className={summaryClassName}>{label}</summary>
        <div className={styles.dropdown} onClick={event => {
            if (event.target instanceof Element && event.target.closest("a, button") && ref.current) ref.current.open = false;
        }}>{children}</div>
    </details>;
}
