"use client";
import { useState } from "react";
import { Button } from "@/app/_components/finser-ui";
export default function SharedLogout({ returnTo = "/acceso-revision" }: { returnTo?: "/acceso-revision" | "/dashboard/aprobaciones" }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(false);
  async function close(){
    if(busy)return;setBusy(true);setError(false);
    try{
      const response=await fetch("/api/public/approval-shared-access/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",cache:"no-store"});
      if(!response.ok)throw new Error();
      window.location.replace(returnTo);
    }catch{setError(true);setBusy(false);}
  }
  return <div><Button variant="secondary" disabled={busy} onClick={()=>void close()}>{busy?"Cerrando...":"Cerrar acceso"}</Button>
    {error&&<p className="mt-2 text-sm text-[var(--fp-danger)]" role="alert">No se pudo cerrar el acceso. Intenta de nuevo.</p>}</div>;
}
