"use client";

import { useRef, useState, type ReactNode, type InputHTMLAttributes, type FocusEvent } from "react";
import Image from "next/image";
import { Check, ChevronDown, ChevronRight, LockKeyhole, Pencil, Phone, UserRound, UsersRound } from "lucide-react";
import { Badge, Button, Input, Select } from "@/app/_components/finser-ui";
import type { CreditClientField, CreditClientFormValues, CreditClientValidationResult } from "@/lib/credit-client-validation";
import { normalizeCreditContactPhoneInput } from "@/lib/credit-contact-phones";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import type { DataCreditoApprovedResult } from "./datacredito-prequalification-gate";
import styles from "./customer-details-form.module.css";

type Option = { value: string; label: string };
type Props = {
  values: CreditClientFormValues;
  validation: CreditClientValidationResult;
  approval: DataCreditoApprovedResult | null;
  nameFields: ReactNode;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onChange: (field: CreditClientField, value: string) => void;
  fieldProps: (field: CreditClientField) => { id: string; onBlur: () => void; "aria-invalid"?: boolean; "aria-describedby"?: string };
  fieldError: (field: CreditClientField) => string;
  documentOptions: readonly Option[];
  departmentOptions: readonly Option[];
  genderOptions: readonly Option[];
  maritalOptions: readonly Option[];
  strata: readonly (string | number)[];
  cities: readonly string[];
};

const titles = ["Datos personales", "Contacto y ubicación", "Referencias familiares"];
const icons = [UserRound, Phone, UsersRound];

export default function CustomerDetailsForm(props: Props) {
  const { values, validation, approval, nameFields, onChange, fieldProps, fieldError } = props;
  const complete = [validation.personalComplete, validation.contactComplete, validation.referencesComplete];
  const firstPending = complete.findIndex(value => !value);
  const [open, setOpen] = useState(firstPending < 0 ? 0 : firstPending);
  // Only committed fields unlock the next block. Keystrokes never trigger navigation.
  const [committed, setCommitted] = useState(complete);
  if (committed.some((done, index) => done && !complete[index])) {
    setCommitted(committed.map((done, index) => done && complete[index]));
  }
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const latest = useRef(complete);
  latest.current = complete;
  const enabled = [true, committed[0] && complete[0], committed[1] && complete[1]];
  const active = open === -1 ? -1 : enabled[open] ? open : firstPending < 0 ? 0 : firstPending;

  function commitBlock(index: number, event: FocusEvent<HTMLElement>) {
    const section = event.currentTarget;
    const nextTarget = event.relatedTarget;
    // Do not remove a field that is about to receive focus inside this block.
    if (nextTarget instanceof Node && section.contains(nextTarget)) return;
    window.requestAnimationFrame(() => {
      if (section.contains(document.activeElement)) return;
      const next = latest.current;
      setCommitted([...next]);
      if (next[index] && index < 2 && !committed[index]) setOpen(index + 1);
    });
  }

  function field(field: CreditClientField, label: string, options?: readonly Option[], input: InputHTMLAttributes<HTMLInputElement> = {}) {
    const error = fieldError(field);
    const common = fieldProps(field);
    const phone = field.endsWith("Telefono");
    const control = options ? (
      <Select id={field} value={values[field]} disabled={field === "clienteTipoDocumento" && Boolean(approval)}
        onBlur={common.onBlur}
        aria-invalid={common["aria-invalid"]} aria-describedby={common["aria-describedby"]}
        onChange={event => onChange(field, event.target.value)}>
        <option value="">Selecciona</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    ) : (
      <Input {...common} {...input} value={field === "clienteDocumento" ? values[field].replace(/\D/g, "") : values[field]}
        type={phone ? "tel" : input.type || "text"} inputMode={phone ? "numeric" : input.inputMode}
        maxLength={phone ? 10 : input.maxLength}
        onChange={event => onChange(field, phone ? normalizeCreditContactPhoneInput(event.target.value) : event.target.value)}
        onPaste={phone ? event => { event.preventDefault(); onChange(field, normalizeCreditContactPhoneInput(event.clipboardData.getData("text"))); } : undefined} />
    );
    return <div className={styles.field} key={field}>
      <label htmlFor={field}>{label}</label>
      {phone ? <div className={styles.phone}><span aria-hidden="true">+57</span>{control}</div> : control}
      {error ? <p id={`${field}-error`} className={styles.error} role="alert">{error}</p> : null}
    </div>;
  }

  const money = (value: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
  const approvedTerms = approval?.offer.financialSettings;
  const financialTerms = approvedTerms && typeof approvedTerms === "object" ? approvedTerms as Record<string, unknown> : null;
  const blocks = [
    <div key="personal">
      <div className={styles.name}>{nameFields}</div>
      {approval && !approval.identity ? <p role="alert" className={styles.error}>No se pudo recuperar la identidad guardada. Solicita revisión autorizada.</p> : null}
      <div className={styles.personalGrid}>
        {field("clienteTipoDocumento", "Tipo de documento", props.documentOptions)}
        {field("clienteDocumento", "Número de documento", undefined, { readOnly: Boolean(approval), inputMode: "numeric" })}
        {field("clienteFechaExpedicion", "Fecha de expedición", undefined, { type: "date" })}
        {field("clienteFechaNacimiento", "Fecha de nacimiento", undefined, { type: "date" })}
      </div>
    </div>,
    <div key="contact">
      <div className={styles.contactTop}>
        {field("clienteTelefono", "WhatsApp", undefined, { autoComplete: "tel-national" })}
        {field("clienteCorreo", "Correo", undefined, { type: "email", autoComplete: "email" })}
      </div>
      <div className={styles.locationGrid}>
        {field("clienteDepartamento", "Departamento", props.departmentOptions)}
        {field("clienteCiudad", "Ciudad", undefined, { list: "cliente-ciudad-options", disabled: !values.clienteDepartamento, autoComplete: "address-level2" })}
        <datalist id="cliente-ciudad-options">{props.cities.map(city => <option key={city} value={city} />)}</datalist>
        {field("clienteGenero", "Género", props.genderOptions)}
        {field("clienteEstadoCivil", "Estado civil", props.maritalOptions)}
        {field("clienteEstrato", "Estrato", props.strata.map(value => ({ value: String(value), label: `Estrato ${value}` })))}
      </div>
      {field("clienteDireccion", "Dirección", undefined, { autoComplete: "street-address" })}
    </div>,
    <div key="references" className={styles.references}>
      {([1, 2] as const).map(number => <fieldset key={number}>
        <legend>Referencia {number}</legend>
        {field(`referenciaFamiliar${number}Nombre`, "Nombre completo")}
        <div className={styles.referenceRow}>
          {field(`referenciaFamiliar${number}Parentesco`, "Parentesco", undefined, { list: "customer-relationship-options" })}
          {field(`referenciaFamiliar${number}Telefono`, "Celular")}
        </div>
      </fieldset>)}
      <datalist id="customer-relationship-options">{["Madre", "Padre", "Hermano(a)", "Hijo(a)", "Cónyuge", "Tío(a)", "Primo(a)", "Abuelo(a)"].map(value => <option key={value} value={value} />)}</datalist>
    </div>,
  ];

  return <div className={styles.form} id="fp-identity-client-details">
    <header className={styles.header}>
      <h2>Datos del cliente</h2>
      <div className={styles.approval}>
        <Badge tone={approval ? "positive" : "neutral"}>{approval ? <Check aria-hidden="true" /> : null}{approval ? "Aprobado" : "Sin aprobación"}</Badge>
        {approval ? <Button variant="secondary" aria-expanded={conditionsOpen} aria-controls="customer-approved-conditions" onClick={() => setConditionsOpen(!conditionsOpen)}>Ver condiciones<ChevronRight aria-hidden="true" /></Button> : null}
      </div>
      <Image className={styles.mascot} src="/assets/creditos/customer-form-mascot.png" alt="" width={140} height={140} />
    </header>
    {approval && conditionsOpen ? <dl id="customer-approved-conditions" className={styles.conditions}>
      <div><dt>Inicial mínima</dt><dd>{approval.offer.initialPaymentPercentage}%</dd></div>
      <div><dt>Crédito máximo</dt><dd>{money(approval.offer.maxFinancedAmount)}</dd></div>
      <div><dt>Plazo máximo</dt><dd>{approval.offer.installmentCount} cuotas</dd></div>
      {approval.offer.maxInstallmentAmount ? <div><dt>Tope de cuota</dt><dd>{money(approval.offer.maxInstallmentAmount)}</dd></div> : null}
      <div><dt>Fianza</dt><dd>{approval.offer.suretyPercentage}%</dd></div>
      {typeof financialTerms?.frecuenciaPago === "string" ? <div><dt>Frecuencia de pago</dt><dd>{getPaymentFrequencyLabel(financialTerms.frecuenciaPago)}</dd></div> : null}
      {typeof financialTerms?.tasaInteresEa === "number" ? <div><dt>Tasa efectiva anual</dt><dd>{financialTerms.tasaInteresEa}%</dd></div> : null}
      {typeof financialTerms?.seguroCuotaPorcentaje === "number" ? <div><dt>Seguro por cuota</dt><dd>{financialTerms.seguroCuotaPorcentaje}%</dd></div> : null}
    </dl> : null}
    {titles.map((title, index) => {
      const Icon = icons[index];
      const expanded = active === index;
      const done = complete[index] && committed[index];
      return <section key={title} className={styles.block} onBlurCapture={event => commitBlock(index, event)} data-customer-block={index}>
        <div className={styles.blockHeader}>
          <button type="button" className={styles.blockToggle} disabled={!enabled[index]} aria-expanded={expanded} aria-controls={`customer-block-${index}`} onClick={() => setOpen(expanded ? -1 : index)}>
            <span className={styles.icon}><Icon aria-hidden="true" /></span>
            <span>{title}</span>
            {index === 0 && approval ? <span className={styles.source}>DataCrédito</span> : null}
            <span className={styles.blockState}>{!enabled[index] ? <><LockKeyhole aria-hidden="true" /><span className={styles.srOnly}>Bloqueado: completa el bloque anterior</span></> : done ? <><Check aria-hidden="true" /><span className={styles.srOnly}>Completado</span></> : <span className={styles.srOnly}>Pendiente</span>}</span>
            {enabled[index] ? <ChevronDown className={expanded ? styles.chevronOpen : ""} aria-hidden="true" /> : null}
          </button>
          {index === 0 && props.canEdit ? <Button variant="ghost" className={styles.edit} onClick={() => { setOpen(0); props.onEdit(); }} aria-pressed={props.editing}><Pencil aria-hidden="true" />{props.editing ? "Listo" : "Editar"}</Button> : null}
        </div>
        <div id={`customer-block-${index}`} hidden={!expanded || !enabled[index]}>{blocks[index]}</div>
      </section>;
    })}
  </div>;
}
