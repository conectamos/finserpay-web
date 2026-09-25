import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractCreditFactorySnapshotDetails } = await jiti.import(
  "../lib/credit-factory-snapshot.ts"
);

const historicalImei = "100000000000001";
const verifiedImei = "352228709273867";
const credit = { imei: verifiedImei, deviceUid: verifiedImei };

function importedSnapshot() {
  return {
    origen: {
      tipo: "IMPORTACION_MASIVA",
      sinFirmaDigital: true,
      imeiTemporalPendienteCorreccion: false,
    },
    equipo: { imei: historicalImei, imeiTemporal: true },
    financiero: { montoCredito: 1200000 },
  };
}

test("la ficha usa el IMEI definitivo de un CSV histórico corregido y conserva el snapshot", () => {
  const snapshot = importedSnapshot();
  const original = structuredClone(snapshot);
  const details = extractCreditFactorySnapshotDetails(snapshot, credit);
  assert.equal(details.paso2.origen, "CONTRATO");
  assert.equal(details.paso2.imei, verifiedImei);
  assert.deepEqual(snapshot, original);
  assert.equal(snapshot.equipo.imei, historicalImei);
});

test("la ficha mantiene el IMEI histórico mientras la corrección siga pendiente", () => {
  const snapshot = importedSnapshot();
  snapshot.origen.imeiTemporalPendienteCorreccion = true;
  assert.equal(extractCreditFactorySnapshotDetails(snapshot, credit).paso2.imei, historicalImei);
  assert.equal(extractCreditFactorySnapshotDetails(importedSnapshot()).paso2.imei, historicalImei);
});

test("la excepción exige origen, ausencia de firma y consistencia de ambos IMEI vigentes", () => {
  const variants = [
    (snapshot) => { snapshot.origen.tipo = "OTRO"; },
    (snapshot) => { snapshot.origen.sinFirmaDigital = false; },
    (snapshot) => { snapshot.equipo.imeiTemporal = false; },
    (snapshot) => { snapshot.financiero.selloFinanciero = { snapshot: { imei: historicalImei } }; },
  ];
  for (const mutate of variants) {
    const snapshot = importedSnapshot();
    mutate(snapshot);
    assert.equal(extractCreditFactorySnapshotDetails(snapshot, credit).paso2.imei, historicalImei);
  }
  assert.equal(
    extractCreditFactorySnapshotDetails(importedSnapshot(), {
      imei: verifiedImei,
      deviceUid: historicalImei,
    }).paso2.imei,
    historicalImei
  );
  assert.equal(
    extractCreditFactorySnapshotDetails({ equipo: { imei: historicalImei } }, credit).paso2.imei,
    historicalImei
  );
});
