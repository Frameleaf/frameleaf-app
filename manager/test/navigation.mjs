// Chromium can invalidate its first connection when the runner's network changes.
export async function navigate(page, origin) {
  try {
    await page.goto(origin);
  } catch (error) {
    if (!String(error.message).includes("net::ERR_NETWORK_CHANGED"))
      throw error;
    try {
      await page.goto(origin);
    } catch (retryError) {
      // The error page from the first navigation can interrupt its network-change retry.
      if (
        !String(retryError.message).includes(
          'is interrupted by another navigation to "chrome-error://chromewebdata/"',
        )
      )
        throw retryError;
      await page.goto(origin);
    }
  }
}
