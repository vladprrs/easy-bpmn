// Small shared utilities: ids, timestamps, hashing, JSON (de)serialization.

export const ONE_HOUR_MS = 60 * 60 * 1000;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO timestamp `ms` milliseconds after `baseIso`. */
export function isoPlusMs(baseIso: string, ms: number): string {
  return new Date(new Date(baseIso).getTime() + ms).toISOString();
}

export function isoIsBefore(a: string, b: string): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export type JsonObject = Record<string, unknown>;

/** Shallow variable merge — later sources win, matching MVP variable semantics. */
export function mergeVariables(
  base: JsonObject,
  overlay: JsonObject | null | undefined,
): JsonObject {
  return { ...base, ...(overlay ?? {}) };
}
