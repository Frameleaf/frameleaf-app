/** Bound idle callbacks while source locks are held without limiting a progressing owner inventory. */
export async function withPasswordCallbackDeadline(
  body: (activity: () => void) => Promise<void>,
  timeoutError: Error,
): Promise<void> {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Promise.withResolvers<never>();
  const activity = () => {
    if (!active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      active = false;
      expired.reject(timeoutError);
    }, 30_000);
  };
  try {
    activity();
    await Promise.race([body(activity), expired.promise]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
