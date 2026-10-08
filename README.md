# Contour Gen

Click a point on the map, pick an area and a contour interval, and export clean topographic contour
lines as an **SVG** (black 1 pt lines, transparent background) or **GeoJSON**. For illustration
and graphics, not GIS analysis.

A browser-only rewrite of the original R/Shiny app. Everything runs client-side, so it can be
hosted as a static site on GitHub Pages.

## How it works

| Step | Original (R) | This version (JS) |
|---|---|---|
| Map | `leaflet` | Leaflet.js |
| Elevation | `elevatr` (`src = "aws"`) | Fetches the same AWS Terrain Tiles (Terrarium PNGs) and decodes them on a canvas |
| Projection | `terra::project` to UTM | `proj4`; the area is a true size x size square in the point's UTM zone |
| Contours | `terra::as.contour` | Marching squares (`src/lib/contour.js`), clipped to the square |
| SVG | `ggplot2` + `svglite` | Written directly (`src/lib/export.js`): 10 in square, 1 pt stroke, one `<path>` per level |
| GPKG | `sf::st_write` | Replaced by GeoJSON (one MultiLineString per level, `elevation_ft` / `elevation_m`) |

The heavy work (tile download, smoothing, tracing) runs in a Web Worker (`src/worker.js`). The
last elevation grid is cached, so changing the interval, smoothing or SVG style re-renders in
well under a second. Isolated bad pixels in the source tiles are removed before tracing.

New since the R version: place search and coordinate entry, smoothing, optional bold index
contours and frame, stroke weight and SVG size, SVG preview, share links (state in the URL
hash), manual tile zoom, a tile budget (max 300 tiles), and a phone layout. SVG paths are named
by elevation (for example `c_1200ft`) and grouped into `index` / `intermediate` layers, so they
show up as named layers in Illustrator or Inkscape.

## Run locally
```bash
npm install
npm run dev          # http://localhost:5174
npm test             # unit tests (Vitest)
npm run build        # static site in dist/
```

### Map tiles (optional CARTO key)
With a CARTO Basemaps key the map uses CARTO's `dark_all` style; without one it falls back to
darkened OpenStreetMap tiles. Copy `.env.example` to `.env.local` and paste the key after
`VITE_CARTO_KEY=`. `.env.local` and `.env.*.local` are gitignored. The key ends up in the
browser, so restrict it to your domains in the CARTO dashboard.

## Deploy
`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
Set the repository secret `VITE_CARTO_KEY`, and set Settings > Pages > Source to
"GitHub Actions".

## Credits
Created by Jonah Bird for DbD. Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
(Mapzen Terrarium). Map data © OpenStreetMap contributors, © CARTO. Place search: Nominatim.
