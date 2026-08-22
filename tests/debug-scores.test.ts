import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { analyzeOccupancy, detectGrid, fullRoi } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

it("score distribution", () => {
  for (const name of ["拼豆图纸1.png", "小黑图纸.png", "屏幕截图 2026-08-22 194733.png"]) {
    const raster = load(`inputs/${name}`);
    const detection = detectGrid(raster, fullRoi(raster));
    const sorted = [...detection.scores].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3);
    console.log(name, `otsu=${detection.threshold.toFixed(3)}`,
      `q10=${q(0.1)} q25=${q(0.25)} q50=${q(0.5)} q60=${q(0.6)} q70=${q(0.7)} q80=${q(0.8)} q90=${q(0.9)} q95=${q(0.95)} max=${sorted[sorted.length - 1].toFixed(3)}`);
    const buckets = new Array(20).fill(0);
    sorted.forEach((s) => buckets[Math.min(19, Math.floor(s * 20))] += 1);
    console.log("hist(0..1, bin=0.05):", buckets.join(","));
  }
});
