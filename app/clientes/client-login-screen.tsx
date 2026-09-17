import type { FormEvent } from "react";
import Image from "next/image";
import { ArrowRight, ChevronRight, Headphones, IdCard, LockKeyhole } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
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
        <header className={styles.header}>
          <div className={styles.wordmark} aria-label="FINSER PAY">
            FINSER <span>PAY</span>
          </div>
          <FinserSupportLink className={styles.headerSupport}>
            <Headphones size={26} strokeWidth={1.7} aria-hidden="true" />
          </FinserSupportLink>
        </header>

        <section className={styles.hero} aria-labelledby="client-login-title">
          <div className={styles.illustration} aria-hidden="true">
            <Image
              className={styles.mascot}
              src="/assets/clientes/mascot-welcome.webp"
              alt=""
              width={1024}
              height={1536}
              sizes="(max-width: 460px) 200px, 210px"
              preload
            />
          </div>
          <h1 id="client-login-title" className={styles.title}>Consulta tu crédito</h1>
          <p className={styles.description}>Ingresa tu documento para ver tus pagos y saldo.</p>
        </section>

        <div className={styles.content}>
          <form className={styles.loginCard} onSubmit={submitDocument} aria-labelledby="documento-label">
            <label id="documento-label" htmlFor="documento" className={styles.label}>
              Número de documento
            </label>
            <div className={styles.field}>
              <IdCard className={styles.inputIcon} size={26} strokeWidth={1.65} aria-hidden="true" />
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
            <Button disabled={loading} type="submit" className={styles.submit} aria-busy={loading}>
              <span>{loading ? "Consultando..." : "CONTINUAR"}</span>
              <ArrowRight size={27} strokeWidth={1.8} aria-hidden="true" />
            </Button>
            {notice ? (
              <div id="client-login-notice" role={notice.tone === "red" ? "alert" : "status"}
                className={`${styles.notice} ${notice.tone === "emerald" ? styles.noticeSuccess : styles.noticeError}`}>
                {notice.text}
              </div>
            ) : null}
          </form>

          <FinserSupportLink className={styles.supportLink}>
            <Headphones className={styles.supportIcon} size={30} strokeWidth={1.8} aria-hidden="true" />
            <span>¿Necesitas ayuda?</span>
            <ChevronRight className={styles.supportArrow} size={23} strokeWidth={1.8} aria-hidden="true" />
          </FinserSupportLink>

          <footer className={styles.footer}>
            <LockKeyhole size={21} strokeWidth={1.6} aria-hidden="true" />
            <span>Portal seguro FINSER PAY</span>
          </footer>
        </div>
      </div>
    </main>
  );
}
