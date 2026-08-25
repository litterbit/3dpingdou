import { clamp } from "./helpers";
import type { Raster, Roi } from "./types";

export function fullRoi(raster: Raster): Roi {
  return { x: 0, y: 0, width: raster.width, height: raster.height };
}

export function normalizeRoi(raster: Raster, roi?: Roi | null): Roi {
  if (!roi) return fullRoi(raster);
  const x = clamp(Math.round(Math.min(roi.x, roi.x + roi.width)), 0, Math.max(0, raster.width - 8));
  const y = clamp(Math.round(Math.min(roi.y, roi.y + roi.height)), 0, Math.max(0, raster.height - 8));
  const right = clamp(Math.round(Math.max(roi.x, roi.x + roi.width)), x + 8, raster.width);
  const bottom = clamp(Math.round(Math.max(roi.y, roi.y + roi.height)), y + 8, raster.height);
  return { x, y, width: right - x, height: bottom - y };
}
