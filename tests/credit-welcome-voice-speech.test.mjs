import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const core = loadReissueModule("lib/credit-welcome-voice-core.ts");
const speech = loadReissueModule("lib/credit-welcome-voice-speech.ts", { "@/lib/credit-welcome-voice-core": core });
const snapshot = () => ({ initialPayment:760000, installmentAmount:159150, installmentCount:18,
  frequency:"QUINCENAL", firstDueDate:"2026-10-17", installmentAmounts:Array(18).fill(159150) });

test("the reported payment is spoken in full without truncation or numeric thousands separators", () => {
  assert.equal(speech.welcomeVoiceMoneySpoken(159150), "ciento cincuenta y nueve mil ciento cincuenta pesos");
  assert.equal(speech.welcomeVoiceMoneySpoken(760000), "setecientos sesenta mil pesos");
  assert.equal(speech.welcomeVoiceMoneySpoken(104850), "ciento cuatro mil ochocientos cincuenta pesos");
  assert.equal(speech.welcomeVoiceMoneySpoken(980000), "novecientos ochenta mil pesos");
});

test("currency retains cents and singular, hundreds, thousands and millions", () => {
  for (const [input, expected] of [[0,"cero pesos"],[1,"un peso"],[21,"veintiún pesos"],
    [100,"cien pesos"],[101,"ciento un pesos"],[1001,"mil un pesos"],
    [21000,"veintiún mil pesos"],[31000,"treinta y un mil pesos"],[1000000,"un millón de pesos"],
    [2000000,"dos millones de pesos"],[1500000,"un millón quinientos mil pesos"],
    [88_251.69,"ochenta y ocho mil doscientos cincuenta y un pesos con sesenta y nueve centavos"],
    [1.01,"un peso con un centavo"],[0.21,"cero pesos con veintiún centavos"]]) {
    assert.equal(speech.welcomeVoiceMoneySpoken(input),expected);
  }
  for (const invalid of [NaN,Infinity,-1,0.001,1e12]) assert.equal(speech.welcomeVoiceMoneySpoken(invalid),null);
});

test("first payment uses a complete Spanish date independent of the host timezone", () => {
  assert.equal(speech.welcomeVoiceDateSpoken("2026-10-17"),"diecisiete de octubre de dos mil veintiséis");
  assert.equal(speech.welcomeVoiceDateSpoken("2026-11-01"),"primero de noviembre de dos mil veintiséis");
  assert.equal(speech.welcomeVoiceDateSpoken("2028-02-29"),"veintinueve de febrero de dos mil veintiocho");
  for (const invalid of ["17/10/2026","2026-10-17T00:00:00Z","2026-02-29","2026-13-01","2026-01-32"])
    assert.equal(speech.welcomeVoiceDateSpoken(invalid),null);
});

test("government identifier is one word per digit, preserving all leading zeros", () => {
  assert.equal(speech.welcomeVoiceDocumentSpoken("38155093"),"tres, ocho, uno, cinco, cinco, cero, nueve, tres");
  assert.equal(speech.welcomeVoiceDocumentSpoken("00.123-456"),"cero, cero, uno, dos, tres, cuatro, cinco, seis");
  assert.equal(speech.welcomeVoiceDocumentSpoken("38155O93"),null);
});

test("registered names retain accents while another person's name is refused", () => {
  assert.equal(speech.welcomeVoiceNameSpoken(" ANA MARÍA PÉREZ ","ana maria perez"),"Ana María Pérez");
  assert.equal(speech.welcomeVoiceNameSpoken("CARLOS LOPEZ","carlos lopez"),"Carlos Lopez");
  assert.equal(speech.welcomeVoiceNameSpoken("Otra Persona","carlos lopez"),null);
});

test("spoken conditions are computed from the verified plan and preserve differing installments", () => {
  const result = speech.buildWelcomeVoiceFinancialSpeech(snapshot());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { initialPayment:"setecientos sesenta mil pesos",
    installmentAmount:"ciento cincuenta y nueve mil ciento cincuenta pesos", installmentCount:"dieciocho cuotas quincenales",
    firstDueDate:"diecisiete de octubre de dos mil veintiséis",
    installmentAmounts:Array(18).fill("ciento cincuenta y nueve mil ciento cincuenta pesos") });
  const unequal = speech.buildWelcomeVoiceFinancialSpeech({...snapshot(),installmentAmounts:[...Array(17).fill(159150),120000]});
  assert.equal(unequal.installmentAmounts[17],"ciento veinte mil pesos");
  assert.equal(speech.buildWelcomeVoiceFinancialSpeech({...snapshot(),installmentCount:1,installmentAmounts:[159150],frequency:"MENSUAL"}).installmentCount,"una cuota mensual");
  assert.equal(speech.buildWelcomeVoiceFinancialSpeech({...snapshot(),installmentCount:21,installmentAmounts:Array(21).fill(159150)}).installmentCount,"veintiuna cuotas quincenales");
  assert.equal(speech.buildWelcomeVoiceFinancialSpeech({...snapshot(),frequency:"CATORCENAL"}).installmentCount,"dieciocho cuotas cada catorce días");
});

test("inconsistent or unpronounceable financial snapshots fail closed", () => {
  for(const patch of [{initialPayment:-1},{installmentAmount:0},{installmentCount:2.5},{installmentCount:1001},
    {frequency:"UNKNOWN"},{firstDueDate:"2026-02-29"},{installmentAmounts:[]},
    {installmentAmounts:Array(18).fill(0)},{installmentAmount:159150.001}])
    assert.equal(speech.buildWelcomeVoiceFinancialSpeech({...snapshot(),...patch}),null);
});
