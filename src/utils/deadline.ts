export async function runWithDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
