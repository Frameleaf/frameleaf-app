// Chromium can invalidate its first connection when the runner's network changes.
export async function navigate(page, origin) {
  try {
    await page.goto(origin);
  } catch (error) {
    const message = String(error.message);
    const networkChanged = message.includes("net::ERR_NETWORK_CHANGED");
    if (!networkChanged && !message.includes("chrome-error://chromewebdata/"))
      throw error;
    try {
      await page.goto(origin);
    } catch (retryError) {
      // The error page from the first navigation can interrupt its network-change retry.
      if (
        !networkChanged ||
        !String(retryError.message).includes(
          'is interrupted by another navigation to "chrome-error://chromewebdata/"',
        )
      )
        throw retryError;
      await page.goto(origin);
    }
  }
}
