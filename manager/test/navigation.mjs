// Chromium can invalidate its first connection when the runner's network changes.
export async function navigate(page, origin) {
  const target = new URL(origin).href;
  const sameTarget = (message) =>
    message.includes(
      `Navigation to "${target}" is interrupted by another navigation to "${target}"`,
    );
  try {
    await page.goto(origin);
  } catch (error) {
    const message = String(error.message);
    const networkChanged = message.includes("net::ERR_NETWORK_CHANGED");
    if (
      !networkChanged &&
      !message.includes("chrome-error://chromewebdata/") &&
      !sameTarget(message)
    )
      throw error;
    try {
      await page.goto(origin);
    } catch (retryError) {
      // The error page from the first navigation can interrupt its network-change retry.
      if (
        !sameTarget(String(retryError.message)) &&
        (!networkChanged ||
          !String(retryError.message).includes(
            'is interrupted by another navigation to "chrome-error://chromewebdata/"',
          ))
      )
        throw retryError;
      await page.goto(origin);
    }
  }
}
