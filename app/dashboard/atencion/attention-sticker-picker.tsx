"use client";
import {useEffect,useRef,useState} from "react";
import {Archive,Plus,Star,Sticker,X} from "lucide-react";
import {Button,Input} from "@/app/_components/finser-ui";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import type {AttentionSavedSticker} from "@/lib/atencion-sticker-library";
import styles from "./attention-sticker-picker.module.css";

export default function AttentionStickerPicker({disabled,onSelect}:{disabled:boolean;onSelect:(file:File)=>void}){
  const [open,setOpen]=useState(false),[items,setItems]=useState<AttentionSavedSticker[]>([]),[filter,setFilter]=useState<"all"|"favorite"|"archived">("all");
  const [name,setName]=useState(""),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const alive=useRef(true),locked=useRef(false),uploadIntent=useRef<string|null>(null),controller=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  async function request<T>(url:string,init:RequestInit={}):Promise<T>{
    const response=await fetch(url,{...init,cache:"no-store",credentials:"same-origin"});const data=await response.json().catch(()=>null);
    if(!response.ok){if([401,403].includes(response.status)&&alive.current)setItems([]);throw new Error(data?.error||"No fue posible consultar la biblioteca.");}return data;
  }
  async function load(){
    if(locked.current)return;locked.current=true;setBusy(true);setError("");const read=new AbortController();controller.current=read;
    try{const data=await request<{items:AttentionSavedSticker[]}>("/api/atencion/stickers",{signal:read.signal});if(alive.current&&!read.signal.aborted)setItems(data.items);}
    catch(failure){if(alive.current&&!read.signal.aborted)setError(failure instanceof Error?failure.message:"No fue posible abrir la biblioteca.");}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  async function save(){
    if(locked.current||!file||!name.trim())return;locked.current=true;setBusy(true);setError("");uploadIntent.current||=crypto.randomUUID();
    const form=new FormData();form.set("file",file);form.set("name",name.trim());form.set("requestId",uploadIntent.current);
    try{const data=await request<{sticker:AttentionSavedSticker}>("/api/atencion/stickers",{method:"POST",body:form});if(alive.current){setItems(current=>[data.sticker,...current.filter(item=>item.id!==data.sticker.id)]);setFile(null);setName("");uploadIntent.current=null;setFilter(data.sticker.archived?"archived":"all");}}
    catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:"No se pudo guardar el sticker.");}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  async function update(item:AttentionSavedSticker,action:"favorite"|"archive"|"restore"){
    if(locked.current)return;locked.current=true;setBusy(true);setError("");
    try{const data=await request<{sticker:AttentionSavedSticker}>(`/api/atencion/stickers/${item.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:crypto.randomUUID(),version:item.version,action,...(action==="favorite"?{favorite:!item.favorite}:{})})});if(alive.current)setItems(current=>current.map(value=>value.id===item.id?data.sticker:value));}
    catch(failure){if(alive.current)setError(`${failure instanceof Error?failure.message:"No se pudo guardar el cambio."} Actualiza la biblioteca antes de otro cambio.`);}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  async function select(item:AttentionSavedSticker){
    if(locked.current||disabled||item.archived)return;locked.current=true;setBusy(true);setError("");
    try{
      const response=await fetch(`/api/atencion/stickers/${item.id}/media`,{cache:"no-store",credentials:"same-origin"});
      if(!response.ok)throw new Error("No se pudo abrir el sticker. Actualiza la biblioteca.");const blob=await response.blob();
      if(blob.type!=="image/webp"||blob.size>500*1024)throw new Error("El sticker recibido no es válido.");
      if(alive.current){onSelect(new File([blob],"sticker.webp",{type:"image/webp"}));setOpen(false);}
    }catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:"No se pudo seleccionar el sticker.");}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  const shown=items.filter(item=>filter==="archived"?item.archived:!item.archived&&(filter!=="favorite"||item.favorite));
  return <><Button type="button" variant="ghost" aria-label="Stickers guardados" title="Stickers" disabled={disabled} onClick={()=>{setOpen(true);void load();}}><Sticker size={20} aria-hidden="true" /></Button>
    <FinserSidePanel open={open} title="Mis stickers" closeLabel="Cerrar stickers" busy={busy} onClose={()=>setOpen(false)}><div className={styles.library}>
      <p>Guarda tus stickers y elige uno para prepararlo en el chat. Después pulsa Enviar.</p>
      <div className={styles.tabs} role="group" aria-label="Colección de stickers">{([["all","Guardados"],["favorite","Favoritos"],["archived","Archivados"]] as const).map(([value,label])=><Button type="button" key={value} variant="ghost" aria-pressed={filter===value} disabled={busy} onClick={()=>setFilter(value)}>{label}</Button>)}</div>
      {error&&<p role="alert" className={styles.error}>{error}</p>}
      <Button type="button" variant="ghost" disabled={busy} onClick={()=>void load()}>{busy?"Consultando…":"Actualizar biblioteca"}</Button>
      <div className={styles.grid}>{shown.map(item=><article key={item.id}><button type="button" className={styles.select} disabled={busy||disabled||item.archived} onClick={()=>void select(item)} aria-label={`Preparar sticker: ${item.name}`}>
        {/* Private same-origin media is not passed to an image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/atencion/stickers/${item.id}/media`} alt={item.name} width={112} height={112} loading="lazy" /><span>{item.name}</span></button>
        <div className={styles.actions}>{item.archived?<Button type="button" variant="ghost" disabled={busy} onClick={()=>void update(item,"restore")}>Restaurar</Button>:<><Button type="button" variant="ghost" disabled={busy} aria-label={`${item.favorite?"Quitar de":"Agregar a"} favoritos: ${item.name}`} aria-pressed={item.favorite} onClick={()=>void update(item,"favorite")}><Star size={18} fill={item.favorite?"currentColor":"none"} /></Button><Button type="button" variant="ghost" disabled={busy} aria-label={`Archivar sticker: ${item.name}`} onClick={()=>void update(item,"archive")}><Archive size={18} /></Button></>}</div></article>)}</div>
      {!shown.length&&!busy&&<p>No tienes stickers en esta sección.</p>}
      <section className={styles.add}><h3><Plus size={18} /> Agregar sticker</h3><label>Nombre<Input maxLength={60} value={name} disabled={busy} onChange={event=>{setName(event.target.value);uploadIntent.current=null;}} /></label><label>Imagen<Input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event=>{const selected=event.target.files?.[0]||null;setFile(selected);uploadIntent.current=null;if(selected&&!name)setName(selected.name.replace(/\.[^.]+$/,"").slice(0,60));event.target.value="";}} /></label>
        {file&&<div className={styles.selectedFile}><span>{file.name}</span><Button type="button" aria-label="Quitar imagen de sticker" variant="ghost" disabled={busy} onClick={()=>{setFile(null);uploadIntent.current=null;}}><X size={18} /></Button></div>}
        <small>JPG o PNG hasta 5 MB; se ajustan a 512 × 512. WebP estático hasta 100 KB o animado hasta 500 KB. Biblioteca personal: 50 stickers / 10 MB, incluidos los archivados.</small><Button type="button" disabled={busy||!file||!name.trim()} onClick={()=>void save()}>Guardar sticker</Button>
      </section>
    </div></FinserSidePanel>
  </>;
}
