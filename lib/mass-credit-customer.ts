export type MassCreditCustomerInput = {
  direccion?: unknown;
  correo?: unknown;
  fechaNacimiento?: unknown;
  sexo?: unknown;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function birthDate(value: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !local) return null;
  const year = Number(iso ? iso[1] : local![3]);
  const month = Number(iso ? iso[2] : local![2]);
  const day = Number(iso ? iso[3] : local![1]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date : null;
}

function gender(value: string) {
  const key = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[\s-]+/g, "_");
  if (["M", "MASCULINO", "HOMBRE", "MALE"].includes(key)) return "MASCULINO";
  if (["F", "FEMENINO", "MUJER", "FEMALE"].includes(key)) return "FEMENINO";
  if (["O", "OTRO"].includes(key)) return "OTRO";
  if (["PREFIERO_NO_DECIR", "PREFIERO_NO_DECIRLO"].includes(key)) return "PREFIERO_NO_DECIR";
  return key;
}

/** Preview and commit normalize the same customer data; no date is invented. */
export function readImportCustomer(input: MassCreditCustomerInput, now = new Date()) {
  const direccion = text(input.direccion);
  const correo = text(input.correo).toLowerCase();
  const rawBirthDate = text(input.fechaNacimiento);
  const fechaNacimiento = birthDate(rawBirthDate);
  const sexo = gender(text(input.sexo));
  const errors: string[] = [];
  const hasControl = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

  if (!direccion) errors.push("DIRECCION obligatoria");
  else if (direccion.length < 5 || direccion.length > 240 || hasControl(direccion)) {
    errors.push("DIRECCION: usa una dirección completa de 5 a 240 caracteres");
  }
  if (!correo) errors.push("CORREO obligatorio");
  else if (correo.length > 254 || hasControl(correo) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    errors.push("CORREO: ingresa un correo electrónico válido");
  }
  if (!rawBirthDate) errors.push("FECHA DE NACIMIENTO obligatoria");
  else if (!fechaNacimiento) {
    errors.push("FECHA DE NACIMIENTO inválida: usa AAAA-MM-DD o día/mes/año");
  } else {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Bogota",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const year = Number(values.year), month = Number(values.month), day = Number(values.day);
    const today = new Date(Date.UTC(year, month - 1, day, 12));
    const beforeBirthday = month < fechaNacimiento.getUTCMonth() + 1 ||
      (month === fechaNacimiento.getUTCMonth() + 1 && day < fechaNacimiento.getUTCDate());
    const age = year - fechaNacimiento.getUTCFullYear() - (beforeBirthday ? 1 : 0);
    if (fechaNacimiento > today) errors.push("FECHA DE NACIMIENTO no puede estar en el futuro");
    else if (age < 18) errors.push("FECHA DE NACIMIENTO: el cliente debe tener al menos 18 años");
  }
  if (!sexo) errors.push("SEXO obligatorio");
  else if (!["MASCULINO", "FEMENINO", "OTRO", "PREFIERO_NO_DECIR"].includes(sexo)) {
    errors.push("SEXO inválido: usa MASCULINO, FEMENINO, OTRO o PREFIERO_NO_DECIR");
  }
  return { direccion, correo, fechaNacimiento, sexo, errors };
}
