import { Card, LoadingState } from "@/app/_components/finser-ui";

export default function CreditosMasivosLoading() {
  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <div className="h-20 animate-pulse border-b border-[#d8dee5] bg-[#f3f5f7]" />
      <Card className="mt-4 !rounded-lg !p-4">
        <LoadingState label="Preparando creditos masivos..." />
      </Card>
    </main>
  );
}
