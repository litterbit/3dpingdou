import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { detectGrid, fullRoi } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

it("debug real charts", () => {
  for (const name of ["拼豆图纸1.png", "小黑图纸.png", "屏幕截图 2026-08-22 194733.png"]) {
    const raster = load(`inputs/${name}`);
    const detection = detectGrid(raster, fullRoi(raster));
    const occupied = detection.occupancy.filter(Boolean).length;
    console.log(name, JSON.stringify({
      size: `${raster.width}x${raster.height}`,
      pitch: `${detection.geometry.cellWidth.toFixed(2)}x${detection.geometry.cellHeight.toFixed(2)}`,
      origin: `${detection.geometry.originX.toFixed(2)},${detection.geometry.originY.toFixed(2)}`,
      grid: `${detection.columns}x${detection.rows}`,
      confidence: detection.confidence.toFixed(2),
      threshold: detection.threshold.toFixed(3),
      occupied: `${occupied}/${detection.occupancy.length} (${(occupied / detection.occupancy.length * 100).toFixed(0)}%)`,
    }));
  }
});
