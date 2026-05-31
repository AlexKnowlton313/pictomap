/**
 * Normalize a thrown value to a display string. Replaces the
 * `err instanceof Error ? err.message : String(err)` dance scattered across
 * the app's catch blocks.
 *
 * Pass `fallback` to show a domain-specific message for non-Error throws
 * (e.g. "Could not load image") instead of a raw `String(err)`.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;
  if (fallback !== undefined) return fallback;
  return String(err);
}
