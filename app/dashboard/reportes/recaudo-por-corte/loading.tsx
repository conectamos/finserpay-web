import { LoadingState } from "@/app/_components/finser-ui";
import styles from "./recaudo-por-corte.module.css";

export default function Loading() {
  return <main className={styles.main}><LoadingState label="Cargando recaudo por corte…" /></main>;
}
