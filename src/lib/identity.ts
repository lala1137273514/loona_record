export function normalizeUsername(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || "anonymous";
}

export function shouldCreateNewUid(value: string | null) {
  return !value;
}
