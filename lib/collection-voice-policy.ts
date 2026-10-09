import { createHmac, timingSafeEqual } from "node:crypto";

const DAY = 86400000;
export function colombiaClock(now: Date) {
  const local = new Date(now.getTime() - 5 * 3600000);
  return { day: local.toISOString().slice(0, 10), weekday: local.getUTCDay(), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}
function easter(year: number) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  return new Date(Date.UTC(year,Math.floor((h+l-7*m+114)/31)-1,(h+l-7*m+114)%31+1));
}
export function colombiaHolidays(year: number) {
  const key=(date:Date)=>date.toISOString().slice(0,10);
  const fixed=(month:number,day:number)=>new Date(Date.UTC(year,month-1,day));
  const monday=(date:Date)=>new Date(date.getTime()+((8-date.getUTCDay())%7)*DAY);
  const holidays=[fixed(1,1),fixed(5,1),fixed(7,20),fixed(8,7),fixed(12,8),fixed(12,25)];
  for(const [month,day] of [[1,6],[3,19],[6,29],[8,15],[10,12],[11,1],[11,11]]) holidays.push(monday(fixed(month,day)));
  const sunday=easter(year);
  for(const delta of [-3,-2]) holidays.push(new Date(+sunday+delta*DAY));
  for(const delta of [39,60,68]) holidays.push(monday(new Date(+sunday+delta*DAY)));
  return new Set(holidays.map(key));
}
export function collectionCallingAllowed(now: Date) {
  if (!Number.isFinite(+now)) return false;
  const c=colombiaClock(now);
  return c.weekday!==0 && !colombiaHolidays(Number(c.day.slice(0,4))).has(c.day)
    && c.hour >= (c.weekday===6?8:7) && c.hour < (c.weekday===6?15:19);
}
export function collectionSlot(now: Date, immediate=false) {
  if(!collectionCallingAllowed(now)) return null;
  const c=colombiaClock(now), hours=c.weekday===6?[8,10,14]:[10,14,17];
  if(immediate) return c.day+"Tmanual";
  return hours.includes(c.hour) && c.minute<10 ? c.day+"T"+String(c.hour).padStart(2,"0") : null;
}
export function nextCollectionDate(now: Date, requestedDay?: string) {
  if(requestedDay && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDay)) throw new Error("Fecha inválida");
  let date=new Date(requestedDay?requestedDay+"T15:00:00Z":+now+DAY);
  if(!Number.isFinite(+date)) throw new Error("Fecha inválida");
  if(requestedDay && date.toISOString().slice(0,10)!==requestedDay) throw new Error("Fecha inválida");
  if(requestedDay===colombiaClock(now).day) {
    const later=new Date(+now+5*60000);
    if(collectionCallingAllowed(later)) return later.toISOString();
  }
  for(let n=0;n<15;n++,date=new Date(+date+DAY)) {
    const at=new Date(date.toISOString().slice(0,10)+"T15:00:00Z");
    if(+at>+now && collectionCallingAllowed(at)) return at.toISOString();
  }
  throw new Error("Sin fecha hábil");
}
export function collectionSessionToken(id:string, secret:string) {
  if(secret.length<32) throw new Error("Integración sin configurar");
  return id+"."+createHmac("sha256",secret).update("finserpay-collection-session:"+id).digest("base64url");
}
export function verifyCollectionSessionToken(token:unknown, secret:string) {
  if(typeof token!=="string" || token.length>100 || secret.length<32) return null;
  const id=token.split(".")[0];
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return null;
  const expected=Buffer.from(collectionSessionToken(id,secret)), supplied=Buffer.from(token);
  return supplied.length===expected.length && timingSafeEqual(supplied,expected)?id:null;
}
