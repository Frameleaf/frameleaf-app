// Chromium can invalidate its first connection when the runner's network changes. It reports that as
// ERR_NETWORK_CHANGED or as the navigation being replaced by its own chrome-error page; retry once.
export async function navigate(page, origin) {
  try {
    await page.goto(origin);
  } catch (error) {
    const message = String(error.message);
    if (
      !message.includes("net::ERR_NETWORK_CHANGED") &&
      !message.includes("chrome-error://chromewebdata/")
    )
      throw error;
    await page.goto(origin);
  }
}
