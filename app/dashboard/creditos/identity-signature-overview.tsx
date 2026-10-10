"use client";

import { Check, Clock3, FileText, UserRound, X } from "lucide-react";
import styles from "./equipment-signature.module.css";

export default function IdentitySignatureOverview({ identityApproved, identityRejected, identityLabel, signed, sent, failed, reissueRequired, ready }: {
  identityApproved: boolean;
  identityRejected: boolean;
  identityLabel: string;
  signed: boolean;
  sent: boolean;
  failed: boolean;
  reissueRequired: boolean;
  ready: boolean;
}) {
  const title = ready ? "Contrato firmado" : identityRejected ? "Identidad no aprobada" : !identityApproved ? "Valida la identidad del cliente" : reissueRequired ? "Nueva firma requerida" : failed ? "Revisa el estado de la firma" : sent ? "Firma pendiente" : "Identidad confirmada";
  const description = ready ? "La identidad y la firma fueron confirmadas." : identityRejected ? "Revisa el resultado y las acciones disponibles para continuar." : !identityApproved ? "Completa la validación para preparar el contrato." : reissueRequired ? "El cliente debe firmar la versión vigente del contrato." : failed ? "Revisa el mensaje y las acciones disponibles para continuar." : sent ? "Esperando la confirmación de la firma del cliente." : "Prepara y envía el contrato para que el cliente lo firme.";
  const signatureLabel = reissueRequired ? "Nueva firma requerida" : signed ? "Confirmada" : failed ? "Requiere revisión" : sent ? "Pendiente" : "Por enviar";
  return <section className={styles.signatureOverview} data-ready={ready} aria-label="Estado de identidad y firma">
    <div className={styles.signatureOutcome} role="status" aria-live="polite">
      <span className={styles.outcomeIcon} data-error={identityRejected || failed} aria-hidden="true">{ready ? <Check /> : identityRejected || failed ? <X /> : <Clock3 />}</span>
      <div><h4>{title}</h4><p>{description}</p></div>
    </div>
    <div className={styles.signatureStates}>
      <div><span className={styles.stateIcon} aria-hidden="true"><UserRound /></span><div><h5>Identidad del cliente</h5><p data-confirmed={identityApproved}>{identityApproved ? <Check aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{identityApproved ? "Validada" : identityLabel}</p></div></div>
      <div><span className={styles.stateIcon} aria-hidden="true"><FileText /></span><div><h5>Firma del contrato</h5><p data-confirmed={signed && !reissueRequired}>{signed && !reissueRequired ? <Check aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{signatureLabel}</p></div></div>
    </div>
  </section>;
}
