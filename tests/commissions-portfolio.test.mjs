import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{alias:{"@":path.resolve(import.meta.dirname,"..")}});
const { commissionBagFromBalances }=await jiti.import("../lib/commission-portfolio.ts");

test("umbral de cartera usa proporción exacta sin redondear para bloquear",()=>{
  for(const [overdueCents,expectedPercent,paused] of [[79900,7.99,false],[79990,7.999,false],[80000,8,true],[80001,8.0001,true]]){
    const bag=commissionBagFromBalances(1,"Aliado",1000000,overdueCents);
    assert.equal(bag.overduePercent,expectedPercent);
    assert.equal(bag.paused,paused);
  }
  assert.deepEqual(commissionBagFromBalances(3,"Sin cartera",0,0),{allyId:3,allyName:"Sin cartera",totalBalance:0,overdueBalance:0,overduePercent:0,paused:false});
});
