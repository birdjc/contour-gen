// Geometry helpers: UTM zone detection, the square area of interest, Web Mercator tile maths.
import proj4 from 'proj4';

export const FT_PER_M = 3.28084;
export const M_PER_MI = 1609.344;
export const MI_PER_KM = 0.621371;
export const TILE = 256;
// UTM is only defined between 80°S and 84°N.
export const LAT_MIN = -80;
export const LAT_MAX = 84;

export const normalizeLon = lon => ((((lon + 180) % 360) + 360) % 360) - 180;

// UTM zone for a longitude (no Norway/Svalbard exceptions, same as the R version).
export function utmZone(lon) {
  const zone = Math.floor((normalizeLon(lon) + 180) / 6) + 1;
  return Math.min(60, Math.max(1, zone));
}

// WGS 84 / UTM EPSG code: 326xx north, 327xx south.
export const utmEpsg = (lat, lon) => (lat >= 0 ? 32600 : 32700) + utmZone(lon);

export const utmProjString = (lat, lon) =>
  `+proj=utm +zone=${utmZone(lon)}${lat < 0 ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;

export const sizeToMeters = (size, unit) => (unit === 'km' ? size * 1000 : size * M_PER_MI);

// Highest tile zoom that keeps the download manageable. Thresholds match the R app: the size is
// normalised to miles and divided by cos(lat) because tiles cover less ground away from the equator.
export function autoZoom(size, unit, lat) {
  const sizeMi = unit === 'km' ? size * MI_PER_KM : size;
  const effective = sizeMi / Math.cos((lat * Math.PI) / 180);
  if (effective < 2) return 15;
  if (effective < 5) return 14;
  if (effective < 15) return 13;
  if (effective < 40) return 12;
  return 11;
}

// The area of interest: a true size x size square in UTM metres centred on the point, plus its
// outline and bounding box in lat/lon. `conv` converts [lon, lat] <-> [easting, northing].
export function squareArea(lat, lon, sizeM) {
  lon = normalizeLon(lon);
  const conv = proj4('WGS84', utmProjString(lat, lon));
  const [e0, n0] = conv.forward([lon, lat]);
  const half = sizeM / 2;
  const xmin = e0 - half, xmax = e0 + half, ymin = n0 - half, ymax = n0 + half;

  // Sample each edge so the lat/lon outline and bbox follow the (slightly curved) projected edges.
  const corners = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
  const STEPS = 8;
  const outline = [];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c], [bx, by] = corners[(c + 1) % 4];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS;
      const [lo, la] = conv.inverse([ax + (bx - ax) * t, ay + (by - ay) * t]);
      outline.push([la, lo]);
    }
  }
  const lats = outline.map(p => p[0]), lons = outline.map(p => p[1]);
  const bbox = {
    south: Math.min(...lats), north: Math.max(...lats),
    west: Math.min(...lons), east: Math.max(...lons)
  };
  return {
    lat, lon, sizeM, conv, outline, bbox,
    xmin, xmax, ymin, ymax,
    zone: utmZone(lon), hemisphere: lat >= 0 ? 'N' : 'S', epsg: utmEpsg(lat, lon)
  };
}

// Web Mercator, in "world" units: x and y in [0, 1], y growing southwards.
export const lonToWorldX = lon => (lon + 180) / 360;
export function latToWorldY(lat) {
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export const worldXToLon = x => x * 360 - 180;
export const worldYToLat = y => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;

// Ground size of one tile pixel in metres.
export const groundResolution = (lat, z) =>
  (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

// Pixel window (global pixel coordinates at zoom z) covering a lat/lon bbox plus `pad` pixels on
// every side, and the tile range needed to fill it. `inner` is the unpadded bbox in grid coordinates.
export function pixelWindow(bbox, z, pad = 0) {
  const n = TILE * 2 ** z;
  const bx0 = Math.floor(lonToWorldX(bbox.west) * n), bx1 = Math.ceil(lonToWorldX(bbox.east) * n);
  const by0 = Math.floor(latToWorldY(bbox.north) * n), by1 = Math.ceil(latToWorldY(bbox.south) * n);
  const px0 = bx0 - pad, py0 = by0 - pad;
  const w = bx1 - bx0 + 2 * pad, h = by1 - by0 + 2 * pad;
  const tx0 = Math.floor(px0 / TILE), tx1 = Math.floor((px0 + w - 1) / TILE);
  const ty0 = Math.floor(py0 / TILE), ty1 = Math.floor((py0 + h - 1) / TILE);
  return {
    z, px0, py0, w, h, tx0, tx1, ty0, ty1,
    tiles: (tx1 - tx0 + 1) * (ty1 - ty0 + 1),
    inner: { x0: pad, y0: pad, x1: pad + bx1 - bx0, y1: pad + by1 - by0 }
  };
}

// Tile zoom to use: the requested one, or (auto) the R heuristic stepped down until the tile
// count fits the budget.
export function resolveZoom(area, size, unit, requested, maxTiles) {
  if (requested !== 'auto') {
    const z = Number(requested);
    return { z, auto: false, tiles: pixelWindow(area.bbox, z).tiles };
  }
  let z = autoZoom(size, unit, area.lat);
  let tiles = pixelWindow(area.bbox, z).tiles;
  while (tiles > maxTiles && z > 8) tiles = pixelWindow(area.bbox, --z).tiles;
  return { z, auto: true, tiles };
}
