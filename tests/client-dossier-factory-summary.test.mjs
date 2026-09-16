import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { extractCreditFactorySnapshotDetails } = await jiti.import(
  "../lib/credit-factory-snapshot.ts"
);
const creditFactoryConsoleSource = readFileSync(
  path.join(
    projectRoot,
    "app/dashboard/creditos/credit-factory-console.tsx"
  ),
  "utf8"
);
const creditRouteSource = readFileSync(
  path.join(projectRoot, "app/api/creditos/route.ts"),
  "utf8"
);
const creditCommandRouteSource = readFileSync(
  path.join(projectRoot, "app/api/creditos/[id]/command/route.ts"),
  "utf8"
);

test("proyecta solo los datos adicionales necesarios del snapshot de Fabrica", () => {
  assert.deepEqual(
    extractCreditFactorySnapshotDetails({
      cliente: {
        estadoCivil: " SOLTERO ",
        estrato: " 3 ",
        datoNoExpuesto: "privado",
      },
      equipo: {
        plataforma: " IPHONE ",
        marca: " Apple ",
        modelo: " iPhone 14 ",
        imei: " 123456789012345 ",
        enrolamientoManualAuditoria: { token: "no-exponer" },
      },
      financiero: {
        valorTotalEquipo: "2600000",
        cuotaInicial: 780000,
        saldoBaseFinanciado: 1820000,
        saldoFinanciado: 2350000,
        tasaInteresEa: 29.24,
        valorInteres: 300000,
        fianzaPorcentaje: 20,
        valorFianza: 230000,
        valorCuota: 75806.45,
        cuotaComercial: 75900,
        cuotas: 31,
        frecuenciaPago: " QUINCENAL ",
        fechaPrimerPago: " 2026-10-02T12:00:00.000Z ",
        seguroCuotaPorcentaje: 0.03,
        valorSeguro: 20000,
        datoNoExpuesto: "privado",
      },
    }),
    {
      clienteEstadoCivil: "SOLTERO",
      clienteEstrato: "3",
      paso2: {
        origen: "CONTRATO",
        plataformaDispositivo: "IPHONE",
        equipoMarca: "Apple",
        equipoModelo: "iPhone 14",
        equipoReferencia: "Apple iPhone 14",
        imei: "123456789012345",
        valorEquipoTotal: 2600000,
        cuotaInicial: 780000,
        saldoBaseFinanciado: 1820000,
        montoCredito: 2350000,
        tasaInteresEa: 29.24,
        valorInteres: 300000,
        fianzaPorcentaje: 20,
        valorFianza: 230000,
        valorCuota: 75806.45,
        valorCuotaComercial: 75900,
        numeroCuotas: 31,
        frecuenciaPago: "QUINCENAL",
        fechaPrimerPago: "2026-10-02T12:00:00.000Z",
        seguroCuotaPorcentaje: 0.03,
        valorSeguro: 20000,
        cargosIncorporados: null,
      },
    }
  );
});

test("normaliza las condiciones originales de snapshots masivos legados", () => {
  const { paso2 } = extractCreditFactorySnapshotDetails({
    equipo: {
      referencia: "Samsung A55",
      imei: "355555555555555",
    },
    financiero: {
      cuotaInicial: 300000,
      saldoBaseFinanciado: 1200000,
      montoCredito: 1550000,
      cargosIncorporados: 350000,
      valorCuota: 125000,
      plazo: 12,
      frecuenciaPago: "MENSUAL",
      fechaPrimerPago: "2026-10-17T12:00:00.000Z",
    },
  });

  assert.equal(paso2.origen, "CONTRATO");
  assert.equal(paso2.equipoReferencia, "Samsung A55");
  assert.equal(paso2.valorEquipoTotal, 1500000);
  assert.equal(paso2.montoCredito, 1550000);
  assert.equal(paso2.numeroCuotas, 12);
  assert.equal(paso2.cargosIncorporados, 350000);
});

test("tolera creditos historicos sin snapshot contractual", () => {
  const empty = {
    clienteEstadoCivil: null,
    clienteEstrato: null,
    paso2: {
      origen: "ACTUAL",
      plataformaDispositivo: null,
      equipoMarca: null,
      equipoModelo: null,
      equipoReferencia: null,
      imei: null,
      valorEquipoTotal: null,
      cuotaInicial: null,
      saldoBaseFinanciado: null,
      montoCredito: null,
      tasaInteresEa: null,
      valorInteres: null,
      fianzaPorcentaje: null,
      valorFianza: null,
      valorCuota: null,
      valorCuotaComercial: null,
      numeroCuotas: null,
      frecuenciaPago: null,
      fechaPrimerPago: null,
      seguroCuotaPorcentaje: null,
      valorSeguro: null,
      cargosIncorporados: null,
    },
  };

  assert.deepEqual(extractCreditFactorySnapshotDetails(null), empty);
  assert.deepEqual(extractCreditFactorySnapshotDetails({}), empty);
  assert.deepEqual(
    extractCreditFactorySnapshotDetails({ cliente: [], equipo: "ANDROID" }),
    empty
  );
});

test("el API expone el resumen saneado y conserva la redaccion por permisos", () => {
  const serializedBlock = creditRouteSource.match(
    /function serializeCredit[\s\S]*?function redactCreditForNonAdmin/
  )?.[0];
  const redactedBlock = creditRouteSource.match(
    /function redactCreditForNonAdmin[\s\S]*?function parseTake/
  )?.[0];

  assert.ok(serializedBlock, "debe existir el serializador de creditos");
  assert.ok(redactedBlock, "debe existir la redaccion para perfiles no admin");
  assert.match(
    serializedBlock,
    /extractCreditFactorySnapshotDetails\(\s*item\.contratoSnapshot\s*\)/
  );
  assert.match(serializedBlock, /clienteEstadoCivil:\s*factorySnapshotDetails\.clienteEstadoCivil/);
  assert.match(serializedBlock, /clienteEstrato:\s*factorySnapshotDetails\.clienteEstrato/);
  assert.match(serializedBlock, /plataformaDispositivo:\s*factorySnapshotDetails\.paso2\.plataformaDispositivo/);
  assert.match(serializedBlock, /resumenFabrica:\s*{\s*paso2:\s*factorySnapshotDetails\.paso2/);
  assert.doesNotMatch(
    serializedBlock,
    /contratoSnapshot:\s*item\.contratoSnapshot/,
    "el endpoint no debe enviar el snapshot contractual completo"
  );
  assert.match(redactedBlock, /clienteEstadoCivil:\s*null/);
  assert.match(redactedBlock, /clienteEstrato:\s*null/);

  assert.match(
    creditCommandRouteSource,
    /clienteEstadoCivil:\s*canViewSensitive\s*\?\s*factorySnapshotDetails\.clienteEstadoCivil\s*:\s*null/
  );
  assert.match(
    creditCommandRouteSource,
    /clienteEstrato:\s*canViewSensitive\s*\?\s*factorySnapshotDetails\.clienteEstrato\s*:\s*null/
  );
  assert.match(
    creditCommandRouteSource,
    /resumenFabrica:\s*{\s*paso2:\s*factorySnapshotDetails\.paso2/
  );
  assert.equal(
    creditCommandRouteSource.match(
      /serializeCredit\(updated, paymentSummary, admin\)/g
    )?.length,
    3,
    "las respuestas administrativas deben conservar el mismo alcance de datos"
  );
});

test("Resumen muestra los pasos 1 y 2 completos y en modo informativo", () => {
  const start = creditFactoryConsoleSource.indexOf(
    "data-client-factory-summary"
  );
  const end = creditFactoryConsoleSource.indexOf(
    '<aside className="rounded-lg',
    start
  );

  assert.ok(start >= 0, "debe existir el resumen de Fabrica");
  assert.ok(end > start, "el resumen debe vivir antes de las acciones rapidas");

  const summaryBlock = creditFactoryConsoleSource.slice(start, end);
  const expectedLabels = [
    "Nombre completo",
    "Primer nombre",
    "Primer apellido",
    "Tipo de documento",
    "Número de documento",
    "Fecha de expedición",
    "Fecha de nacimiento",
    "Género",
    "Estado civil",
    "Estrato",
    "Celular / WhatsApp",
    "Correo electrónico",
    "Departamento de residencia",
    "Ciudad de residencia",
    "Dirección completa",
    "Plataforma",
    "Marca",
    "Modelo",
    "Referencia del equipo",
    "IMEI / deviceUid",
    "Precio de venta acordado",
    "Cuota inicial",
    "Saldo base financiado",
    "Seguro",
    "Obligación total",
    "Número de cuotas",
    "Frecuencia",
    "Valor de la cuota",
    "Primer pago",
  ];

  assert.match(summaryBlock, /data-factory-step="1"/);
  assert.match(summaryBlock, /data-factory-step="2"/);
  assert.match(summaryBlock, /Paso 1 · Cliente/);
  assert.match(summaryBlock, /Paso 2 · Equipo y financiación/);
  assert.match(summaryBlock, /Referencias familiares/);
  assert.match(summaryBlock, /Solo lectura/);

  for (const label of expectedLabels) {
    assert.ok(summaryBlock.includes(`label="${label}"`), `falta ${label}`);
  }

  assert.match(summaryBlock, /selectedCredit\.referenciasFamiliares\.map/);
  assert.match(summaryBlock, /dossierDate\(selectedCredit\.clienteFechaExpedicion\)/);
  assert.match(summaryBlock, /dossierDate\(selectedCredit\.clienteFechaNacimiento\)/);
  assert.match(
    creditFactoryConsoleSource,
    /selectedCreditFactoryStepTwo\s*=\s*selectedCredit\?\.resumenFabrica\?\.paso2/
  );
  assert.match(
    creditFactoryConsoleSource,
    /selectedFactoryUsesContractSnapshot\s*=\s*selectedCreditFactoryStepTwo\?\.origen\s*===\s*"CONTRATO"/
  );
  const derivationStart = creditFactoryConsoleSource.indexOf(
    "const selectedCreditFactoryStepTwo"
  );
  const derivationEnd = creditFactoryConsoleSource.indexOf(
    "const selectedFactoryInitialPaymentPercentage",
    derivationStart
  );
  const derivationBlock = creditFactoryConsoleSource.slice(
    derivationStart,
    derivationEnd
  );
  assert.doesNotMatch(
    derivationBlock,
    /selectedCreditFactoryStepTwo\?\.[^\n]*\?\?\s*selectedCredit\?\./,
    "un campo contractual no debe caer individualmente a un valor operativo"
  );
  assert.match(summaryBlock, /selectedFactoryEquipmentValue/);
  assert.match(summaryBlock, /selectedFactoryFinancedBalance/);
  assert.match(summaryBlock, /selectedFactoryTotalObligation/);
  assert.match(summaryBlock, /selectedFactoryFirstPaymentDate/);
  assert.match(summaryBlock, /selectedFactoryInsuranceValue/);
  assert.match(summaryBlock, /condiciones originales aceptadas/);
  assert.doesNotMatch(summaryBlock, /selectedCredit\.fechaProximoPago/);
  assert.ok(!summaryBlock.includes('label="Próximo pago"'));
  assert.ok(!summaryBlock.includes('label="Referencia de pago"'));
  assert.doesNotMatch(
    summaryBlock,
    /<(?:input|select|textarea)\b/,
    "el resumen no debe permitir editar los datos de Fabrica"
  );
});
