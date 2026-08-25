import type { Raster } from "./types";

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const at = (raster: Raster, x: number, y: number) => (y * raster.width + x) * 4;
export const distance = (a: readonly number[], b: readonly number[]) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1)];
}

export function luminance(raster: Raster, x: number, y: number): number {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return raster.data[p] * 0.299 + raster.data[p + 1] * 0.587 + raster.data[p + 2] * 0.114;
}

export function rgbAt(raster: Raster, x: number, y: number): [number, number, number] {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
}

export function interp(values: readonly number[], position: number): number {
  if (!values.length) return 0;
  const low = clamp(Math.floor(position), 0, values.length - 1);
  const high = clamp(low + 1, 0, values.length - 1);
  const t = clamp(position - low, 0, 1);
  return values[low] * (1 - t) + values[high] * t;
}

export function colorKey(color: readonly number[] | null): string {
  return color ? color.join(",") : "empty";
}
