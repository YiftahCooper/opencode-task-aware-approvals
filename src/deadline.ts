/** Bounds the caller's wait. Side-effecting operations also clean up late results. */
export async function withTimeout<T>(input: {
  operation: Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Reviewer timed out.")),
          Math.max(1, input.timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
