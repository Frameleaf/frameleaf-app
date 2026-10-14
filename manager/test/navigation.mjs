// Chromium can invalidate its first connection when the runner's network changes.
export async function navigate(page, origin) {
  try {
    await page.goto(origin);
  } catch (error) {
    if (!String(error.message).includes('net::ERR_NETWORK_CHANGED')) throw error;
    await page.goto(origin);
  }
}
