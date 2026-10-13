/** Normalize the former default brand without changing provider IDs or custom names. */
export function normalizeProfileProviderName(value: string | undefined): string {
  const name = value?.trim() || "";
  return !name || /^claude[ -]code[ -]router$/i.test(name) ? "AgentRouter" : name;
}
