import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { getPolicyBandRemovalPlan, applyPolicyBandRemoval } =
  await jiti.import("../lib/datacredito/policy-band-removal.ts");
const { parseDataCreditoPolicyBands } = await jiti.import("../lib/datacredito/policy.ts");

function bands() {
  return ["ANDROID", "IPHONE"].flatMap((platform) => [
    { id: `${platform}-none`, platform, scoreMin: "-1", scoreMax: "-1", decision: "RECHAZADO",
      initialPaymentPercentage: "40", suretyPercentage: "75", maxFinancedAmount: "600000",
      installmentCount: "16", maxInstallmentAmount: platform === "IPHONE" ? "160000" : "" },
    { id: `${platform}-low`, platform, scoreMin: "0", scoreMax: "449", decision: "RECHAZADO",
      initialPaymentPercentage: "40", suretyPercentage: "75", maxFinancedAmount: "600000",
      installmentCount: "16", maxInstallmentAmount: platform === "IPHONE" ? "160000" : "" },
    { id: `${platform}-middle`, platform, scoreMin: "450", scoreMax: "699", decision: "APROBADO",
      initialPaymentPercentage: "20", suretyPercentage: "75", maxFinancedAmount: "1200000",
      installmentCount: "24", maxInstallmentAmount: platform === "IPHONE" ? "150000" : "" },
    { id: `${platform}-high`, platform, scoreMin: "700", scoreMax: "950", decision: "APROBADO",
      initialPaymentPercentage: "10", suretyPercentage: "80", maxFinancedAmount: "2500000",
      installmentCount: "36", maxInstallmentAmount: platform === "IPHONE" ? "160000" : "" },
  ]);
}

function canonical(rows) {
  return rows.map((row) => ({ ...row, scoreMin: Number(row.scoreMin), scoreMax: Number(row.scoreMax),
    initialPaymentPercentage: Number(row.initialPaymentPercentage), suretyPercentage: Number(row.suretyPercentage),
    maxFinancedAmount: Number(row.maxFinancedAmount), installmentCount: Number(row.installmentCount),
    maxInstallmentAmount: row.platform === "ANDROID" ? null : Number(row.maxInstallmentAmount) }));
}

test("quitar la primera, intermedia o última banda conserva la cobertura que valida el servidor", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    for (const part of ["low", "middle", "high"]) {
      const original = bands().reverse();
      const before = structuredClone(original);
      const sourceId = `${platform}-${part}`;
      const plan = getPolicyBandRemovalPlan(original, sourceId);
      assert.equal(plan.kind, "MERGE");
      assert.equal(plan.options.length, part === "middle" ? 2 : 1);
      for (const option of plan.options) {
        const result = applyPolicyBandRemoval(original, sourceId, option.targetBandId);
        assert.equal(result.length, original.length - 1);
        assert.ok(!result.some((row) => row.id === sourceId));
        assert.doesNotThrow(() => parseDataCreditoPolicyBands(canonical(result), { requireFinancingTerms: true }));
        assert.deepEqual(result.filter((row) => row.platform !== platform), original.filter((row) => row.platform !== platform));
        const targetBefore = original.find((row) => row.id === option.targetBandId);
        const targetAfter = result.find((row) => row.id === option.targetBandId);
        assert.deepEqual(targetAfter, { ...targetBefore, scoreMin: String(option.scoreMin), scoreMax: String(option.scoreMax) });
        for (const row of result.filter((row) => row.id !== option.targetBandId)) {
          assert.equal(row, original.find((item) => item.id === row.id));
        }
      }
      assert.deepEqual(original, before);
    }
  }
});

test("la banda intermedia exige elegir expresamente la vecina y conserva sus condiciones", () => {
  const original = bands();
  const plan = getPolicyBandRemovalPlan(original, "ANDROID-middle");
  assert.deepEqual(plan, { kind: "MERGE", removedBandId: "ANDROID-middle", options: [
    { targetBandId: "ANDROID-low", scoreMin: 0, scoreMax: 699 },
    { targetBandId: "ANDROID-high", scoreMin: 450, scoreMax: 950 },
  ] });
  assert.throws(() => applyPolicyBandRemoval(original, "ANDROID-middle"), /Selecciona una banda vecina/);
  const rejectedTarget = applyPolicyBandRemoval(original, "ANDROID-middle", "ANDROID-low");
  assert.equal(rejectedTarget.find((row) => row.id === "ANDROID-low").decision, "RECHAZADO");
  const approvedTarget = applyPolicyBandRemoval(original, "ANDROID-middle", "ANDROID-high");
  assert.equal(approvedTarget.find((row) => row.id === "ANDROID-high").decision, "APROBADO");
  assert.equal(approvedTarget.find((row) => row.id === "ANDROID-high").maxFinancedAmount, "2500000");
});

test("rechaza destinos inexistentes, otra plataforma, bandas lejanas y la banda eliminada", () => {
  for (const target of ["missing", "IPHONE-middle", "ANDROID-none", "ANDROID-high", "ANDROID-low"]) {
    assert.throws(() => applyPolicyBandRemoval(bands(), "ANDROID-low", target), /Selecciona una banda vecina/);
  }
  assert.throws(() => applyPolicyBandRemoval(bands(), "missing", "ANDROID-low"), /La banda cambió/);
});

test("Sin información y la última banda numérica tienen protección explícita", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    const original = bands();
    assert.equal(getPolicyBandRemovalPlan(original, `${platform}-none`).kind, "BLOCKED");
    assert.throws(() => applyPolicyBandRemoval(original, `${platform}-none`), /Sin información es obligatoria/);
    const onlyNumeric = original.filter((row) => row.platform !== platform || row.id === `${platform}-none` || row.id === `${platform}-low`)
      .map((row) => row.id === `${platform}-low` ? { ...row, scoreMax: "950" } : row);
    const plan = getPolicyBandRemovalPlan(onlyNumeric, `${platform}-low`);
    assert.equal(plan.kind, "BLOCKED");
    assert.match(plan.message, /al menos una banda/);
    assert.throws(() => applyPolicyBandRemoval(onlyNumeric, `${platform}-low`), /al menos una banda/);
  }
});

test("solo una fila nueva incompleta puede quitarse sin reasignar sus puntajes", () => {
  const draft = { ...bands()[0], id: "new-draft", scoreMin: "", scoreMax: "", decision: "" };
  const original = [...bands(), draft];
  assert.equal(getPolicyBandRemovalPlan(original, draft.id).kind, "BLOCKED");
  assert.deepEqual(getPolicyBandRemovalPlan(original, draft.id, { isNewBand: true }),
    { kind: "DIRECT", removedBandId: draft.id });
  assert.deepEqual(applyPolicyBandRemoval(original, draft.id, undefined, { isNewBand: true }), bands());
  assert.throws(() => applyPolicyBandRemoval(original, draft.id, "ANDROID-low", { isNewBand: true }), /sin reasignar/);
  assert.throws(() => applyPolicyBandRemoval(original, draft.id), /Completa o restaura/);
  assert.equal(getPolicyBandRemovalPlan(original.filter((row) => row.id !== draft.id), "ANDROID-middle",
    { isNewBand: true }).kind, "MERGE", "Una banda con rango válido siempre requiere destino explícito");
  assert.equal(original.at(-1), draft);
});

test("los rangos inválidos de una banda publicada bloquean la operación", () => {
  for (const [scoreMin, scoreMax] of [["", "699"], ["450", ""], ["700", "699"], ["0.5", "699"], ["450", "951"], ["-1", "699"]]) {
    const original = bands().map((row) => row.id === "ANDROID-middle" ? { ...row, scoreMin, scoreMax } : row);
    const plan = getPolicyBandRemovalPlan(original, "ANDROID-middle");
    assert.equal(plan.kind, "BLOCKED");
    assert.match(plan.message, /Completa o restaura/);
  }
});

test("descartar una banda nueva superpuesta restaura una cobertura válida", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    const draft = { ...bands().find((row) => row.platform === platform),
      id: `${platform}-new`, scoreMin: "0", scoreMax: "100", decision: "APROBADO" };
    const original = [...bands(), draft];
    assert.equal(getPolicyBandRemovalPlan(original, draft.id).kind, "BLOCKED");
    assert.deepEqual(getPolicyBandRemovalPlan(original, draft.id, { isNewBand: true }),
      { kind: "DIRECT", removedBandId: draft.id });
    const result = applyPolicyBandRemoval(original, draft.id, undefined, { isNewBand: true });
    assert.deepEqual(result, bands());
    assert.doesNotThrow(() => parseDataCreditoPolicyBands(canonical(result), { requireFinancingTerms: true }));
  }
});

test("una banda nueva que cubre una división exige reasignar sus puntajes", () => {
  const original = bands().map((row) => row.id === "ANDROID-middle" ? { ...row, scoreMin: "550" } : row);
  const split = { ...original.find((row) => row.id === "ANDROID-middle"),
    id: "new-split", scoreMin: "450", scoreMax: "549" };
  original.push(split);
  const plan = getPolicyBandRemovalPlan(original, split.id, { isNewBand: true });
  assert.equal(plan.kind, "MERGE");
  assert.throws(() => applyPolicyBandRemoval(original, split.id, undefined, { isNewBand: true }), /Selecciona una banda vecina/);
  const result = applyPolicyBandRemoval(original, split.id, "ANDROID-middle", { isNewBand: true });
  assert.doesNotThrow(() => parseDataCreditoPolicyBands(canonical(result), { requireFinancingTerms: true }));
});

test("huecos, superposiciones e identificadores repetidos requieren corrección antes de reasignar", () => {
  for (const scoreMin of ["448", "451", ""]) {
    const original = bands().map((row) => row.id === "ANDROID-middle" ? { ...row, scoreMin } : row);
    assert.equal(getPolicyBandRemovalPlan(original, "ANDROID-low").kind, "BLOCKED");
    assert.throws(() => applyPolicyBandRemoval(original, "ANDROID-low", "ANDROID-middle"), /Completa los rangos/);
  }
  const repeated = [...bands(), { ...bands()[0] }];
  assert.throws(() => applyPolicyBandRemoval(repeated, "ANDROID-low", "ANDROID-middle"), /identificadores repetidos/);
});

test("aplicar un plan vuelve a comprobar los rangos actuales y rechaza una selección obsoleta", () => {
  const original = bands();
  const planned = getPolicyBandRemovalPlan(original, "ANDROID-middle");
  assert.equal(planned.kind, "MERGE");
  const targetId = planned.options[0].targetBandId;
  const changed = original.map((row) => row.id === targetId ? { ...row, scoreMax: "300" } : row);
  assert.throws(() => applyPolicyBandRemoval(changed, "ANDROID-middle", targetId), /Completa los rangos/);
  assert.throws(() => applyPolicyBandRemoval(original.filter((row) => row.id !== "ANDROID-middle"), "ANDROID-middle", targetId), /La banda cambió/);
});
