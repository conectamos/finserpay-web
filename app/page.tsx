import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ExternalLink, Headphones, ShieldCheck, Smartphone, Wallet, ArrowUpRight, Check, Store, CreditCard } from "lucide-react";
import FinserBrand from "./_components/finser-brand";
import PublicHeader from "./_components/public-site/header";
import WhereToBuy from "./_components/public-site/where-to-buy";
import MerchantApplicationForm from "./_components/public-site/merchant-application-form";
import styles from "./_components/public-site/public-site.module.css";

export const metadata: Metadata = {
  title: "FINSER PAY | Créditos, pagos y comercios aliados",
  description: "Financiación de iPhone y Android, consulta de crédito, medios de pago y postulación para comercios aliados FINSER PAY.",
  alternates: { canonical: "https://finserpay.com/" },
  openGraph: {
    title: "FINSER PAY | Tu próximo celular empieza aquí",
    description: "Financiación de iPhone y Android en comercios aliados. Consulta tu crédito, conoce cómo pagar y recibe soporte.",
    url: "https://finserpay.com/", locale: "es_CO", type: "website",
    images: [{ url: "https://finserpay.com/assets/public-site/mascota-premium-v2.webp", alt: "Mascota de FINSER PAY" }],
  },
};

// Canal de la página pública aprobada; los portales conservan su canal operativo.
const PUBLIC_SUPPORT_URL = "https://wa.me/573124085562";
const features = [
  { Icon: Smartphone, title: "Consulta tu crédito", text: "Visualiza tus cuotas y el estado de tu financiación." },
  { Icon: Wallet, title: "Paga con facilidad", text: "Encuentra el canal que prefieras y ten a mano tus datos." },
  { Icon: Headphones, title: "Estamos para ayudarte", text: "Habla con nuestro equipo si necesitas orientación." },
];

export default function PublicHomePage() {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#contenido">Saltar al contenido</a>
      <PublicHeader />
      <main id="contenido">
        <section className={styles.hero} id="inicio" aria-labelledby="hero-title">
          <div className={`${styles.container} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>TU PRÓXIMO CELULAR, CON FINSER PAY</p>
              <h1 id="hero-title">El celular que<br />quieres.<br /><em>A tu alcance.</em></h1>
              <p>Estrena iPhone o Android con financiación en nuestros comercios aliados. Da el siguiente paso con FINSER PAY.</p>
              <div className={styles.actions}>
                <a className={`${styles.button} ${styles.primary}`} href={PUBLIC_SUPPORT_URL} target="_blank" rel="noopener noreferrer">Quiero mi celular <ArrowUpRight size={18} aria-hidden="true" /></a>
                <Link className={`${styles.button} ${styles.outline}`} href="/clientes">Ya soy cliente <ArrowRight size={18} aria-hidden="true" /></Link>
              </div>
              <small><ShieldCheck size={17} aria-hidden="true" />La aprobación depende de la evaluación de cada solicitud.</small>
            </div>
            <div className={styles.heroVisual}>
              <div className={styles.visualOrbit} aria-hidden="true" />
              <span className={styles.visualLabel}>UN NUEVO CELULAR.<br /><b>NUEVAS POSIBILIDADES.</b></span>
              <picture>
                <img src="/assets/public-site/mascota-premium-v2.webp" alt="Celular FINSER PAY con acabado de cristal y titanio, extendiendo la mano" width={800} height={1200} fetchPriority="high" />
              </picture>
              <div className={styles.visualBadge}><span><Check size={20} aria-hidden="true" /></span><div><b>Contigo, en cada paso.</b><small>Tu próxima oportunidad empieza aquí.</small></div></div>
            </div>
          </div>
        </section>
        <div className={`${styles.container} ${styles.quickAccess}`} aria-label="Accesos rápidos">
          <Link href="/clientes"><span className={styles.quickIcon}><CreditCard size={22} aria-hidden="true" /></span><div><b>Mi crédito</b><span>Consulta tus cuotas y pagos</span></div><ArrowUpRight size={22} aria-hidden="true" /></Link>
          <a href="#pagos"><span className={styles.quickIcon}><Wallet size={22} aria-hidden="true" /></span><div><b>Quiero pagar</b><span>Encuentra tus medios de pago</span></div><ArrowUpRight size={22} aria-hidden="true" /></a>
          <a href="#comercios"><span className={styles.quickIcon}><Store size={22} aria-hidden="true" /></span><div><b>Mi negocio con FINSER</b><span>Conoce cómo ser aliado</span></div><ArrowUpRight size={22} aria-hidden="true" /></a>
        </div>
        <WhereToBuy />
        <section className={`${styles.section} ${styles.howItWorks}`} aria-labelledby="pasos-title">
          <div className={styles.container}>
            <div className={styles.split}><div><p className={styles.sectionLabel}>ASÍ DE FÁCIL</p><h2 id="pasos-title">Más cerca de tu<br />próximo celular.</h2></div><p>Elige el equipo que va contigo.<br />Nosotros te acompañamos en el proceso.</p></div>
            <ol className={styles.steps}>
              <li><span>01</span><Smartphone size={25} aria-hidden="true" /><h3>Elige tu celular</h3><p>Encuentra tu iPhone o Android en un comercio aliado.</p></li>
              <li><span>02</span><ShieldCheck size={25} aria-hidden="true" /><h3>Solicita tu crédito</h3><p>El comercio te acompaña con la solicitud y su evaluación.</p></li>
              <li><span>03</span><Wallet size={25} aria-hidden="true" /><h3>Estrena y paga tus cuotas</h3><p>Consulta tu financiación y tus pagos desde el portal de clientes.</p></li>
            </ol>
          </div>
        </section>
        <section className={`${styles.section} ${styles.clientSection}`} id="clientes" aria-labelledby="clientes-title">
          <div className={styles.container}>
            <div className={styles.split}>
              <div><p className={styles.sectionLabel}>PARA CLIENTES</p><h2 id="clientes-title">Tu crédito.<br /><span>Siempre a la mano.</span></h2></div>
              <div><p>Revisa el estado de tu crédito, conoce tus próximas cuotas y accede a nuestros canales de atención.</p><Link className={styles.textLink} href="/clientes">Ir al portal de clientes <ArrowRight size={18} aria-hidden="true" /></Link></div>
            </div>
            <div className={styles.features}>{features.map(({ Icon, title, text }) => <article key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div>
          </div>
        </section>
        <section className={`${styles.section} ${styles.payments}`} id="pagos" aria-labelledby="pagos-title">
          <div className={styles.container}>
            <div className={`${styles.split} ${styles.heading}`}><div><p className={styles.sectionLabel}>MEDIOS DE PAGO</p><h2 id="pagos-title">Elige cómo pagar<span className={styles.accent}>.</span></h2></div><p>Ten presente tu número de cédula para identificar tu crédito cuando el canal lo solicite.</p></div>
            <div className={styles.cards}>
              <Link className={`${styles.paymentCard} ${styles.darkCard}`} href="/clientes"><span className={styles.symbol}><CreditCard aria-hidden="true" size={24} /></span><div><h3>Portal de clientes</h3><p>Consulta tu crédito y las opciones de pago disponibles, incluido Nequi.</p></div><b>Ir al portal <ExternalLink size={17} aria-hidden="true" /></b></Link>
              <article className={styles.paymentCard}><span className={styles.symbol} aria-hidden="true">B</span><div><h3>Bre-B</h3><p>Llave a nombre de FINSER PAY</p><strong>902052909</strong></div><small>Verifica los datos antes de confirmar.</small></article>
              <article className={styles.paymentCard}><span className={`${styles.symbol} ${styles.efectySymbol}`}><img src="/branding/efecty-logo.svg" alt="Efecty" width={70} height={32} /></span><div><h3>Efecty</h3><p>Convenio</p><strong>113950</strong></div><small>Referencia: cédula del titular.</small></article>
            </div>
          </div>
        </section>
        <section className={`${styles.section} ${styles.merchant}`} id="comercios" aria-labelledby="comercios-title">
          <div className={`${styles.container} ${styles.merchantGrid}`}>
            <div><p className={styles.sectionLabel}>COMERCIOS ALIADOS</p><h2 id="comercios-title">Tu negocio puede<br />llegar más lejos<span className={styles.accent}>.</span></h2><p>Ofrece financiación de celulares con FINSER PAY. Postula tu comercio y nuestro equipo te contactará para revisar la vinculación.</p>
              <ol><li><b>01</b> Registra los datos de tu negocio.</li><li><b>02</b> Revisamos tu postulación.</li><li><b>03</b> Te contactamos para continuar.</li></ol>
              <Link className={styles.textLink} href="/aliados">Ya soy aliado: ingresar <ArrowRight size={18} aria-hidden="true" /></Link>
            </div>
            <MerchantApplicationForm />
          </div>
        </section>
        <section className={styles.support} id="soporte" aria-labelledby="soporte-title"><div className={`${styles.container} ${styles.supportGrid}`}><div><p className={styles.sectionLabel}>SOPORTE FINSER PAY</p><h2 id="soporte-title">¿Necesitas ayuda?</h2><p>Si tienes preguntas sobre tu crédito, cuotas o acceso al portal, escríbenos.</p></div><a className={`${styles.button} ${styles.lime}`} href={PUBLIC_SUPPORT_URL} target="_blank" rel="noopener noreferrer">Escribir por WhatsApp <ArrowRight size={18} aria-hidden="true" /></a></div></section>
      </main>
      <footer className={styles.footerShell}><div className={`${styles.container} ${styles.footer}`}><div><a href="#inicio" aria-label="FINSER PAY, inicio"><div className={styles.brand}><FinserBrand dark accentPay wordmarkOnly showTagline={false} /></div></a><p>INNOVACIÓN FINANCIERA CON CONFIANZA</p></div><nav aria-label="Enlaces del pie de página"><Link href="/clientes">Portal de clientes</Link><Link href="/aliados">Acceso de aliados</Link><a href="#pagos">Medios de pago</a><a href="#donde-comprar">¿Dónde comprar?</a><a href="#comercios">Comercios</a><a href={PUBLIC_SUPPORT_URL} target="_blank" rel="noopener noreferrer">Soporte</a></nav><small>© {new Date().getFullYear()} FINSER PAY<br /><Link href="/politica-privacidad">Política de privacidad</Link></small></div></footer>
    </div>
  );
}
