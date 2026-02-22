/**
 * Wraps an unknown error value in a new Error with additional context.
 * Preserves the original error as `cause`.
 */
export function wrapError(context: string, err: unknown): Error {
  if (err instanceof Error) {
    return new Error(`${context}: ${err.message}`, { cause: err });
  }
  return new Error(`${context}: ${String(err)}`);
}
