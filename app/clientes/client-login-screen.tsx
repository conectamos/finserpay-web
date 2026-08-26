import type { FormEvent } from "react";
import Image from "next/image";
import {
  ArrowRight,
  ChevronRight,
  Headphones,
  IdCard,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import FinserSupportLink from "@/app/_components/finser-support-link";
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
            <div className={styles.wordmark} aria-label="FINSER PAY">
              FINSER <span>PAY</span>
            </div>

            <FinserSupportLink className={styles.headerSupport}>
              <Headphones size={30} strokeWidth={1.65} aria-hidden="true" />
              <span className="sr-only">¿Necesitas ayuda?</span>
            </FinserSupportLink>
          </header>

          <div className={styles.illustration} aria-hidden="true">
            <span className={styles.mascotGlow} />
            <Image
              className={styles.mascot}
              src="/assets/creditos/identity-approved-mascot.png"
              alt=""
              width={1024}
              height={1536}
              sizes="(max-width: 460px) 176px, 176px"
              preload
            />
            <span className={styles.shieldBadge}>
              <ShieldCheck fill="currentColor" strokeWidth={1.65} />
            </span>
          </div>

          <div className={styles.heroCopy}>
            <h1 id="client-login-title" className={styles.title}>
              Tu crédito,
              <span>
                siempre contigo<i>.</i>
              </span>
            </h1>
            <p className={styles.description}>
              Consulta tus cuotas, pagos y saldo.
            </p>
          </div>
        </section>

        <div className={styles.content}>
          <section className={styles.loginCard} aria-labelledby="login-card-title">
            <h2 id="login-card-title" className={styles.cardTitle}>
              Consulta tu crédito
            </h2>
            <p className={styles.cardSubtitle}>
              Ingresa tu número de documento para continuar.
            </p>

            <form className={styles.form} onSubmit={submitDocument}>
              <label htmlFor="documento" className="sr-only">
                Número de documento
              </label>
              <div className={styles.field}>
                <IdCard
                  className={styles.inputIcon}
                  size={31}
                  strokeWidth={1.45}
                  aria-hidden="true"
                />
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
                  placeholder="Número de documento"
                  required
                  minLength={5}
                  maxLength={20}
                  aria-describedby={notice ? "client-login-notice" : undefined}
                  aria-invalid={notice?.tone === "red" || undefined}
                  className={styles.input}
                />
              </div>

              <button
                disabled={loading}
                type="submit"
                className={styles.submit}
                aria-busy={loading}
              >
                <span>{loading ? "Consultando..." : "Continuar"}</span>
                <ArrowRight size={30} strokeWidth={1.7} aria-hidden="true" />
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
          </section>

          <FinserSupportLink className={styles.supportLink}>
            <span className={styles.supportIcon} aria-hidden="true">
              <Headphones size={29} strokeWidth={1.55} />
            </span>
            <span>¿Necesitas ayuda?</span>
            <ChevronRight className={styles.supportArrow} size={25} aria-hidden="true" />
          </FinserSupportLink>

          <footer className={styles.footer}>
            <LockKeyhole size={25} strokeWidth={1.45} aria-hidden="true" />
            <span>Portal seguro FINSER PAY</span>
          </footer>
        </div>
      </div>
    </main>
  );
}
