# Landmark place pack

`build.mjs` writes `landmarks.ndjson.gz`, the list of notable places that asset coordinates are matched
against (FL-351). One JSON object per line: Wikidata id, name, localised names, kind, centre, radius in
metres, rank (Wikipedia language editions) and, for area places, outer boundary rings as `[lon, lat]` pairs.

```sh
node build.mjs <output-directory>
```

`classes.json` holds the place classes, the notability bar for each, a deny-list and the well-known places
the build refuses to ship without. The published file is pinned by checksum in `../geodata.lock`.

## Licence

Boundaries are © OpenStreetMap contributors and are made available under the Open Database License
(https://opendatacommons.org/licenses/odbl/1-0/, https://www.openstreetmap.org/copyright). The pack is a
derivative database under the same licence; this script is the method that produces it. Identifiers, names,
kinds and ranks come from Wikidata (CC0).
