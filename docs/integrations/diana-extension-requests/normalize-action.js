// Read-only action. Native events alone authorize a direct extension.
const body = params.trigger.body;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
if (!record(body)) throw new Error("Consulta de prórroga no válida");
if (body.args !== undefined && (!record(body.args) || Object.keys(body).some(key => key !== "args"))) throw new Error("Consulta de prórroga no válida");
const data = body.args === undefined ? body : body.args;
if (Object.keys(data).some(key => !["cedula", "folio"].includes(key))) throw new Error("Campos de consulta no válidos");
if (typeof data.cedula !== "string" || !/^\d{5,15}$/.test(data.cedula) || typeof data.folio !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(data.folio)) throw new Error("Cédula o folio no válido");
module.exports = { request_body: JSON.stringify({ accion: "consultar_solicitud", cedula: data.cedula, folio: data.folio }) };
