function normalizedNameTokens(value: string): string[] | null {
  if (typeof value !== "string" || !value || value.length > 240 || value !== value.trim() ||
    !/^[a-z]+(?: [a-z]+)*$/.test(value)) return null;
  const tokens = value.split(" ");
  return tokens.length <= 20 ? tokens : null;
}

/** Additional names are allowed; this comparison alone does not verify a full legal identity. */
export function matchesRegisteredWelcomeVoiceName(providedNormalized: string, registeredNormalized: string): boolean {
  const provided = normalizedNameTokens(providedNormalized);
  const registered = normalizedNameTokens(registeredNormalized);
  if (!provided || !registered) return false;
  if (providedNormalized === registeredNormalized) return true;
  if (registered.length < 2 || provided.length < registered.length || provided[0] !== registered[0]) return false;
  let matched = 0;
  for (const token of provided) {
    if (token === registered[matched]) matched++;
    if (matched === registered.length) return true;
  }
  return false;
}
