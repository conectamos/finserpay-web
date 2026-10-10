"use client";

import { useId } from "react";
import EquipmentVisual from "./equipment-visual";
import styles from "./equipment-signature.module.css";

const exactCurrency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 20,
});

function money(value: number | null) {
  return value !== null && Number.isFinite(value) ? exactCurrency.format(value) : "—";
}

export type CreditFinancingProposalProps = {
  deviceName: string;
  deviceBrand: string;
  platform: "iphone" | "android" | null;
  imageUrl?: string | null;
  ready: boolean;
  installmentLabel: string;
  installmentValue: number;
  price: number;
  initial: number | null;
  financed: number | null;
  term: number | null;
};

export default function CreditFinancingProposal({
  deviceName, deviceBrand, platform, imageUrl, ready,
  installmentLabel, installmentValue, price, initial, financed, term,
}: CreditFinancingProposalProps) {
  const titleId = useId();
  const name = deviceName.trim();
  const brand = deviceBrand.trim();
  const showBrand = Boolean(brand && name && !name.toLocaleLowerCase().startsWith(brand.toLocaleLowerCase()));

  return (
    <section
      className={`fp-step2-proposal ${styles.proposal}`}
      aria-labelledby={titleId}
      aria-live="polite"
      aria-atomic="true"
      data-ready={ready}
    >
      <div className={`fp-step2-proposal-intro ${styles.proposalIntro}`}>
        <h4 id={titleId}>Tu propuesta</h4>
        <picture className={styles.proposalMascot}>
          <source media="(prefers-reduced-motion: reduce)" srcSet="/assets/creditos/client-validation-peek-mascot.png" />
          <img src="/assets/public-site/mascota-animada.webp" width={512} height={768} alt="" />
        </picture>
      </div>
      <div className={styles.proposalBody}>
        <div className={styles.proposalDevice}>
          <EquipmentVisual reference={name} platform={platform} imageUrl={imageUrl} />
          <div>
            <strong>{name || "Sin equipo seleccionado"}</strong>
            {showBrand ? <small>{brand}</small> : null}
          </div>
        </div>
        <dl className="fp-step2-proposal-metrics">
          <div className="fp-step2-proposal-installment">
            <dt>{installmentLabel}</dt>
            <dd>{ready ? money(installmentValue) : "—"}</dd>
          </div>
          <div><dt>Valor del equipo</dt><dd>{price > 0 ? money(price) : "—"}</dd></div>
          <div><dt>Inicial</dt><dd>{money(initial)}</dd></div>
          <div><dt>Financiado</dt><dd>{money(financed)}</dd></div>
          <div><dt>Plazo</dt><dd>{term !== null && term > 0 ? `${term} cuotas` : "—"}</dd></div>
        </dl>
      </div>
    </section>
  );
}
