import { describe, it, expect } from 'vitest';
import {
  utmZone, utmEpsg, autoZoom, squareArea, pixelWindow, resolveZoom, normalizeLon,
  lonToWorldX, latToWorldY, worldXToLon, worldYToLat, M_PER_MI
} from '../src/lib/geo.js';

describe('UTM zone', () => {
  it('matches the R utm_epsg()', () => {
    expect(utmZone(-105.27)).toBe(13);
    expect(utmEpsg(40.01, -105.27)).toBe(32613);
    expect(utmEpsg(-33.92, 18.42)).toBe(32734);
    expect(utmZone(-180)).toBe(1);
    expect(utmZone(179.99)).toBe(60);
  });
  it('normalises wrapped longitudes', () => {
    expect(normalizeLon(-465.27)).toBeCloseTo(-105.27, 9);
    expect(normalizeLon(200)).toBeCloseTo(-160, 9);
  });
});

describe('autoZoom', () => {
  it('uses the R thresholds with the cos(lat) correction', () => {
    expect(autoZoom(1, 'mi', 0)).toBe(15);
    expect(autoZoom(4, 'mi', 0)).toBe(14);
    expect(autoZoom(4, 'mi', 40)).toBe(13); // 4 / cos(40°) = 5.2
    expect(autoZoom(10, 'km', 0)).toBe(13);
    expect(autoZoom(30, 'mi', 0)).toBe(12);
    expect(autoZoom(100, 'mi', 0)).toBe(11);
  });
});

describe('Web Mercator', () => {
  it('round-trips', () => {
    for (const [lat, lon] of [[0, 0], [40.015, -105.27], [-54.8, -68.3], [70, 25]]) {
      expect(worldYToLat(latToWorldY(lat))).toBeCloseTo(lat, 9);
      expect(worldXToLon(lonToWorldX(lon))).toBeCloseTo(lon, 9);
    }
  });
});

describe('squareArea', () => {
  const area = squareArea(40.015, -105.27, 4 * M_PER_MI);
  it('is a true square in UTM metres around the point', () => {
    expect(area.xmax - area.xmin).toBeCloseTo(4 * M_PER_MI, 6);
    expect(area.ymax - area.ymin).toBeCloseTo(4 * M_PER_MI, 6);
    const [e, n] = area.conv.forward([-105.27, 40.015]);
    expect((area.xmin + area.xmax) / 2).toBeCloseTo(e, 6);
    expect((area.ymin + area.ymax) / 2).toBeCloseTo(n, 6);
    expect(area.epsg).toBe(32613);
  });
  it('has a lat/lon bbox around the point of about the right size', () => {
    const { south, north, west, east } = area.bbox;
    expect(south).toBeLessThan(40.015);
    expect(north).toBeGreaterThan(40.015);
    expect(west).toBeLessThan(-105.27);
    expect(east).toBeGreaterThan(-105.27);
    expect((north - south) * 111.32).toBeCloseTo(6.44, 0); // km
  });
});

describe('pixelWindow / resolveZoom', () => {
  const area = squareArea(40.015, -105.27, 4 * M_PER_MI);
  it('covers the bbox with padding and lists the tiles', () => {
    const win = pixelWindow(area.bbox, 13, 10);
    expect(win.inner.x0).toBe(10);
    expect(win.w).toBe(win.inner.x1 + 10);
    expect(win.tiles).toBe((win.tx1 - win.tx0 + 1) * (win.ty1 - win.ty0 + 1));
    expect(win.tiles).toBeGreaterThan(0);
    expect(win.tiles).toBeLessThan(16);
  });
  it('steps auto zoom down to fit the tile budget', () => {
    const big = squareArea(70, 25, 100 * M_PER_MI);
    const r = resolveZoom(big, 100, 'mi', 'auto', 300);
    expect(r.tiles).toBeLessThanOrEqual(300);
    expect(r.z).toBeLessThan(11);
    expect(resolveZoom(area, 4, 'mi', 'auto', 300).z).toBe(13);
    expect(resolveZoom(area, 4, 'mi', '15', 300)).toMatchObject({ z: 15, auto: false });
  });
});
