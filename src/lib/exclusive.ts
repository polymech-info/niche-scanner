export function createExclusive(message: string) {
  let busy: Promise<unknown> | null = null;
  return async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new Error(message);
    const run = fn();
    busy = run;
    try {
      return await run;
    } finally {
      if (busy === run) busy = null;
    }
  };
}
