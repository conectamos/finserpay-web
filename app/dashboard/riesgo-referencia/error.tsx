"use client";
import { Button, EmptyState } from "@/app/_components/finser-ui";
export default function Error({ reset }: { reset: () => void }) {
  return <EmptyState title="No se pudo cargar el riesgo por referencia" description="Intenta nuevamente para consultar los datos de cartera." action={<Button onClick={reset}>Reintentar</Button>} />;
}
