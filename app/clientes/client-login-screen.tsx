import Image from "next/image";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight,
  BellRing,
  ChevronDown,
  ChevronRight,
  Headphones,
  LockKeyhole,
  MessageCircle,
  ShieldCheck,
  UserRound,
  Zap,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import FinserSupportLink from "@/app/_components/finser-support-link";
import { FINSER_PAY_SUPPORT_DISPLAY } from "@/lib/support";
import styles from "./client-login-screen.module.css";

type ClientLoginNotice = {
  text: string;
  tone: "red" | "emerald";
} | null;

type ClientLoginScreenProps = {
  documento: string;
  loading: boolean;
  notice: ClientLoginNotice;
  onSubmit: (documento: string) => void;
};

function LoginBenefit({
  icon,
  label,
  detail,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <div className={styles.benefit}>
      <span className={styles.benefitIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.benefitText}>
        <strong>{label}</strong>
        <span>{detail}</span>
      </span>
    </div>
  );
}

export default function ClientLoginScreen({
  documento,
  loading,
  notice,
  onSubmit,
}: ClientLoginScreenProps) {
  const submitDocument = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onSubmit(String(formData.get("documento") || documento));
  };

  return (
    <main className={styles.page}>
      <div className={styles.canvas}>
        <section className={styles.hero} aria-labelledby="client-login-title">
          <header className={styles.header}>
            <div className={styles.brand}>
              <FinserBrand
                accentPay
                compact
                dark
                plainMark
                showTagline={false}
              />
            </div>

            <FinserSupportLink className={styles.helpPill}>
              <Headphones size={20} strokeWidth={1.8} aria-hidden="true" />
              <span className={styles.helpLong}>¿Necesitas ayuda?</span>
              <span className={styles.helpShort}>Ayuda</span>
              <ChevronRight
                className={styles.helpChevron}
                size={16}
                aria-hidden="true"
              />
            </FinserSupportLink>
          </header>

          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} aria-hidden="true" />
            Portal de clientes
          </div>

          <div className={styles.showcase}>
            <div className={styles.copy}>
              <h1 id="client-login-title" className={styles.title}>
                Tu crédito,
                <span className={styles.titleLine}>
                  siempre <span className={styles.titleAccent}>contigo.</span>
                </span>
              </h1>
              <div className={styles.titleRule} aria-hidden="true" />
              <p className={styles.description}>
                Consulta tus cuotas, realiza pagos y revisa tu saldo cuando quieras.
              </p>
            </div>

            <div className={styles.phoneStage} aria-hidden="true">
              <span className={styles.orbit} />
              <span className={styles.orbitSmall} />
              <span className={styles.phoneGlow} />
              <span className={styles.pedestalGlow} />
              <span className={styles.pedestal} />
              <div className={styles.phone}>
                <div className={styles.phoneScreen}>
                  <Image
                    src="/icons/finserpay-client-512.png"
                    alt=""
                    width={96}
                    height={96}
                    priority
                    className={styles.phoneMark}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className={styles.benefits} aria-label="Beneficios del portal">
            <LoginBenefit
              icon={<ShieldCheck width="100%" height="100%" strokeWidth={1.7} />}
              label="Seguro"
              detail="y confiable"
            />
            <LoginBenefit
              icon={<Zap width="100%" height="100%" strokeWidth={1.7} />}
              label="Rápido"
              detail="y fácil"
            />
            <LoginBenefit
              icon={<BellRing width="100%" height="100%" strokeWidth={1.7} />}
              label="Siempre"
              detail="informado"
            />
          </div>
        </section>

        <div className={styles.content}>
          <section className={styles.loginCard} aria-labelledby="login-card-title">
            <div className={styles.cardHeader}>
              <span className={styles.cardIcon} aria-hidden="true">
                <UserRound size={29} strokeWidth={1.7} />
              </span>
              <div>
                <h2 id="login-card-title" className={styles.cardTitle}>
                  Inicia sesión
                </h2>
                <p className={styles.cardSubtitle}>Ingresa tus datos para continuar</p>
              </div>
            </div>

            <form className={styles.form} onSubmit={submitDocument}>
              <label htmlFor="documento" className="sr-only">
                Documento de identidad
              </label>
              <div className={styles.field}>
                <span className={styles.documentType} aria-label="Tipo de documento: cédula de ciudadanía">
                  CC
                  <ChevronDown size={16} strokeWidth={2.2} aria-hidden="true" />
                </span>
                <input
                  id="documento"
                  name="documento"
                  defaultValue={documento}
                  onInput={(event) => {
                    const normalized = event.currentTarget.value.replace(/\D/g, "");
                    if (event.currentTarget.value !== normalized) {
                      event.currentTarget.value = normalized;
                    }
                  }}
                  inputMode="numeric"
                  autoComplete="username"
                  placeholder="Número de cédula"
                  aria-describedby={notice ? "client-login-notice" : undefined}
                  aria-invalid={notice?.tone === "red" || undefined}
                  className={styles.input}
                />
                <UserRound
                  className={styles.inputIcon}
                  size={26}
                  strokeWidth={1.55}
                  aria-hidden="true"
                />
              </div>

              <button
                disabled={loading}
                type="submit"
                className={styles.submit}
                aria-busy={loading}
              >
                <span aria-hidden="true" />
                <span>{loading ? "Consultando..." : "Continuar"}</span>
                <ArrowRight size={29} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </form>

            {notice ? (
              <div
                id="client-login-notice"
                role={notice.tone === "red" ? "alert" : "status"}
                className={`${styles.notice} ${
                  notice.tone === "emerald"
                    ? styles.noticeSuccess
                    : styles.noticeError
                }`}
              >
                {notice.text}
              </div>
            ) : null}

            <div className={styles.protection}>
              <span className={styles.protectionIcon} aria-hidden="true">
                <LockKeyhole size={19} strokeWidth={1.7} />
              </span>
              <span>
                <strong>Tu conexión está protegida</strong>
                Consulta siempre desde el portal oficial de FINSER PAY.
              </span>
            </div>
          </section>

          <FinserSupportLink className={styles.supportCard}>
            <span className={styles.supportIcon} aria-hidden="true">
              <Headphones size={24} strokeWidth={1.8} />
            </span>
            <span className={styles.supportCopy}>
              <strong>¿Necesitas ayuda?</strong>
              <span>Estamos aquí para ti</span>
            </span>
            <span className={styles.whatsApp}>
              <span className={styles.whatsAppIcon} aria-hidden="true">
                <MessageCircle size={20} fill="currentColor" strokeWidth={1.5} />
              </span>
              {FINSER_PAY_SUPPORT_DISPLAY}
              <ChevronRight size={18} aria-hidden="true" />
            </span>
          </FinserSupportLink>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerBrand}>
            FINSER <span>PAY</span>
          </div>
          <div className={styles.footerTrust}>
            <ShieldCheck size={16} color="var(--fp-lime)" aria-hidden="true" />
            Conectamos confianza
          </div>
        </footer>
      </div>
    </main>
  );
}
