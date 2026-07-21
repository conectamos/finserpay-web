"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, Card } from "@/app/_components/finser-ui";

export default function ReportesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto grid min-h-[70vh] w-full max-w-3xl place-items-center px-4 py-10">
      <Card className="w-full !rounded-lg !p-8 text-center">
        <AlertTriangle className="mx-auto h-9 w-9 text-[#b42318]" strokeWidth={1.6} />
        <h1 className="mt-4 text-xl font-black text-[#151a21]">No pudimos cargar los reportes</h1>
        <p className="mt-2 text-sm text-[#667085]">La informacion no fue modificada. Puedes intentar consultar nuevamente.</p>
        <Button className="mt-5" onClick={reset}>
          <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
          Reintentar
        </Button>
      </Card>
    </main>
  );
}
