// Tiny local assertion helpers for the repo's pure unit tests. Keeping these
// local makes CI deterministic and removes a network fetch from every test run.

function inspect(value: unknown): string {
  return Deno.inspect(value, { depth: Infinity, sorted: true });
}

export function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = inspect(actual);
  const e = inspect(expected);
  if (a !== e) {
    throw new Error(message ?? `Values are not equal.\nActual: ${a}\nExpected: ${e}`);
  }
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  message?: string,
): void {
  if (!actual.includes(expected)) {
    throw new Error(
      message ??
        `String did not include expected text.\nActual: ${actual}\nExpected: ${expected}`,
    );
  }
}

export function assertThrows(
  fn: () => unknown,
  errorClassOrMessage?: (new (...args: never[]) => Error) | string,
  messageIncludes?: string,
): void {
  try {
    fn();
  } catch (err) {
    if (
      typeof errorClassOrMessage === "function" && !(err instanceof errorClassOrMessage)
    ) {
      throw new Error(`Expected ${errorClassOrMessage.name}, got ${inspect(err)}`);
    }
    if (
      messageIncludes &&
      (!(err instanceof Error) || !err.message.includes(messageIncludes))
    ) {
      throw new Error(
        `Thrown error did not include "${messageIncludes}": ${inspect(err)}`,
      );
    }
    return;
  }
  throw new Error(
    typeof errorClassOrMessage === "string"
      ? errorClassOrMessage
      : "Expected function to throw",
  );
}
