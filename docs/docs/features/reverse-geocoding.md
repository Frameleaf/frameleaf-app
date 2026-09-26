# Reverse Geocoding

Frameleaf supports local [Reverse Geocoding](https://en.wikipedia.org/wiki/Reverse_geocoding) using data from the [GeoNames](https://www.geonames.org/) geographical database. This data is loaded into the Postgres database on each minor version upgrade, allowing all queries to be run on your own server.

## Extraction

During Exif Extraction, assets with latitudes and longitudes are reverse geocoded to determine their City, State, and Country.

## Place names you type

In the viewer's information card, **Edit location** lets the owner of an item type its City, State or region and Country, next to its coordinates. A place name typed there is kept: reverse geocoding does not replace it when the metadata is read again. Emptying a field clears that name.

Moving an item's pin without touching its place names hands naming back to reverse geocoding, which then names the new spot. An item's coordinates can be moved but not removed.

## Usage

Data from a reverse geocode is displayed in the image details, and used in [Smart Search](/features/searching.md). Place names also appear in the **Places** filter when you search, so you can narrow results to a city, state or country.
