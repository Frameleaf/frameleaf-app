export const gotoWithNetworkChangeRetry = async (page, origin) => {
  try {
    return await page.goto(origin);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("net::ERR_NETWORK_CHANGED")
    ) {
      throw error;
    }
    await page.waitForURL("chrome-error://chromewebdata/", {
      waitUntil: "load",
      timeout: 10_000,
    });
    return page.goto(origin);
  }
};
