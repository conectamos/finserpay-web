// Flow Studio Code node. No credential or customer data is logged.
const body = params.trigger.body;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
if (!record(body)) throw new Error("Solicitud de prórroga no válida");
if (body.args !== undefined && (!record(body.args) || Object.keys(body).some(key => key !== "args"))) throw new Error("Solicitud de prórroga no válida");
const data = body.args === undefined ? body : body.args;
const keys = ["accion", "cedula", "folio", "dias", "valorCompromiso", "fechaCompromiso", "motivo", "codigo"];
if (Object.keys(data).some(key => !keys.includes(key))) throw new Error("Campos de prórroga no válidos");
let output;
if (data.accion === "consultar") {
  if (typeof data.codigo !== "string" || !/^PR-[A-F0-9]{16}$/.test(data.codigo)) throw new Error("Código de propuesta no válido");
  output = { accion: "consultar", codigo: data.codigo };
} else if (data.accion === "proponer") {
  const numeric = (value, pattern) => typeof value === "number" ? value : typeof value === "string" && pattern.test(value) ? Number(value) : NaN;
  const dias = numeric(data.dias, /^[1-4]$/);
  const amount = numeric(data.valorCompromiso, /^\d{1,13}(?:\.\d{1,2})?$/);
  if (![1, 2, 3, 4].includes(dias) || !Number.isFinite(amount) || amount <= 0 || amount > 1e12 || Math.round(amount * 100) / 100 !== amount) throw new Error("Días o importe no válidos");
  if (!["cedula", "folio", "fechaCompromiso", "motivo"].every(key => typeof data[key] === "string")) throw new Error("Faltan los datos de la propuesta");
  output = { accion: "proponer", cedula: data.cedula, folio: data.folio, dias,
    valorCompromiso: amount, fechaCompromiso: data.fechaCompromiso, motivo: data.motivo };
} else throw new Error("Acción de prórroga no válida");
module.exports = { request_body: JSON.stringify(output) };
