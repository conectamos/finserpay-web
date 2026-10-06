import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const { applySadminChange, parseSadminChange, sadminRegistration } = await jiti.import("../lib/credit-sadmin-state.ts");

test("SADMIN solo acepta cambios explícitos con versión y tipos correctos", () => {
  for (const input of [null, [], {}, {version:-1,field:"creditoCreado",value:true},
    {version:0,field:"creditoCreado",value:"true"}, {version:0,field:"estado",value:"CREADO_SADMIN"},
    {version:0,field:"numeroCredito",value:123}, {version:0,field:"numeroCredito",value:"x".repeat(81)},
    {version:0,field:"numeroCredito",value:"ABC\nDEF"}, {version:0,field:"creditoCreado",value:true,actorUserId:1}]) {
    assert.throws(() => parseSadminChange(input), error => error.status === 400);
  }
  assert.deepEqual(parseSadminChange({version:0,field:"numeroCredito",value:"  000123-A  "}), {version:0,field:"numeroCredito",value:"000123-A"});
  for (const [estadoCreacion, reason] of [["PENDIENTE_CREAR",null],["CREADO_CORRECTAMENTE",null],["ERROR_CREACION","Falló el alta"],["REQUIERE_REVISION","Validar número"]]) {
    assert.deepEqual(parseSadminChange({version:0,field:"estadoCreacion",value:estadoCreacion,reason}), {version:0,field:"estadoCreacion",value:estadoCreacion,reason});
  }
  assert.throws(() => parseSadminChange({version:0,field:"estadoCreacion",value:"DESCONOCIDO",reason:null}), error => error.code === "INVALID_SADMIN_RESULT");
  for (const reason of [null,""," ","x".repeat(501),"línea\u0000oculta"]) {
    assert.throws(() => parseSadminChange({version:0,field:"estadoCreacion",value:"ERROR_CREACION",reason}), error => error.code === "INVALID_SADMIN_REASON");
  }
});

test("la tercera casilla requiere un número guardado y las tres completan SADMIN", () => {
  let current = sadminRegistration();
  assert.equal(current.estadoCreacion, "PENDIENTE_CREAR");
  assert.throws(() => applySadminChange(current, {version:0,field:"numeroCreditoConfirmado",value:true}), error => error.code === "SADMIN_NUMBER_REQUIRED");
  assert.throws(() => applySadminChange(current, {version:0,field:"estadoCreacion",value:"CREADO_CORRECTAMENTE",reason:null}), error => error.code === "SADMIN_CREATION_INCOMPLETE");
  current = applySadminChange(current, parseSadminChange({version:0,field:"estadoCreacion",value:"ERROR_CREACION",reason:" Falló el alta "}));
  assert.equal(current.estadoCreacion, "ERROR_CREACION");
  assert.equal(current.motivoEstado, "Falló el alta");
  current = applySadminChange(current, {version:0,field:"estadoCreacion",value:"REQUIERE_REVISION",reason:"Validar identidad"});
  assert.equal(current.estadoCreacion, "REQUIERE_REVISION");
  current = applySadminChange(current, {version:0,field:"estadoCreacion",value:"PENDIENTE_CREAR",reason:null});
  assert.equal(current.motivoEstado, null);
  for (const [field, value] of [["codeudorCreado",true],["creditoCreado",true],["numeroCredito","000123-A"]]) {
    current = applySadminChange(current, parseSadminChange({version:0,field,value}));
    assert.equal(current.estado, "PENDIENTE");
  }
  current = applySadminChange(current, {version:0,field:"numeroCreditoConfirmado",value:true});
  assert.equal(current.estado, "CREADO_SADMIN");
  assert.equal(current.estadoCreacion, "CREADO_CORRECTAMENTE");
  assert.equal(current.motivoEstado, null);
  assert.equal(applySadminChange(current,{version:0,field:"creditoCreado",value:false}).estado,"PENDIENTE");
  const edited = applySadminChange(current, {version:0,field:"numeroCredito",value:"000124-A"});
  assert.equal(edited.numeroCreditoConfirmado, false);
  assert.equal(edited.estado,"PENDIENTE");
  assert.equal(edited.estadoCreacion,"PENDIENTE_CREAR");
});

test("versión obsoleta rechazada y fechas JSON de PostgreSQL se interpretan como UTC", () => {
  const current = sadminRegistration({version:2,codeudorCreado:true,creditoCreado:true,numeroCreditoConfirmado:true,
    numeroCredito:"0001",updatedAt:"2026-09-17T15:00:00.123",completedAt:"2026-09-17T15:00:00.123"});
  assert.equal(current.updatedAt,"2026-09-17T15:00:00.123Z");
  assert.equal(current.completedAt,"2026-09-17T15:00:00.123Z");
  assert.throws(() => applySadminChange(current,{version:1,field:"creditoCreado",value:false}),error => error.code === "SADMIN_CHANGED" && error.status === 409);
});
