/** Publish a collection search only while its album and page request are still current. */
export const publishCollectionPage = async <T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
  publish: (result: T) => void,
  finish: () => void,
): Promise<void> => {
  try {
    const result = await request();
    if (isCurrent()) {
      publish(result);
    }
  } catch (error) {
    if (isCurrent()) {
      throw error;
    }
  } finally {
    if (isCurrent()) {
      finish();
    }
  }
};
