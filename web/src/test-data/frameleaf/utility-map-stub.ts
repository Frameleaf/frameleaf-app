/** What the utility asked the map to do, and what the map reports back, for the map picker specs. */
export const mapStub = {
  calls: [] as string[],
  inside: true,
  center: { lng: 0, lat: 0 },
  viewChanged: () => {},
};
