export function merchantMapsUrl(direccion: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccion)}`;
}

export function merchantPhoneUrl(telefono: string) {
  return `tel:+${telefono.replace(/\D/g, "")}`;
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es").trim();
}

export function filterPublicMerchants<T extends { nombre: string; direccion: string }>(merchants: T[], query: string) {
  const search = normalize(query);
  return merchants.filter((merchant) => normalize(`${merchant.nombre} ${merchant.direccion}`).includes(search));
}
