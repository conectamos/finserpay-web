export function isValidCreditDeviceReplacementImei(value: unknown) {
  const imei = String(value || "").trim();
  if (!/^\d{15}$/.test(imei)) return false;

  let checksum = 0;
  for (let index = 0; index < imei.length; index += 1) {
    let digit = Number(imei[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    checksum += digit;
  }

  return checksum % 10 === 0;
}
