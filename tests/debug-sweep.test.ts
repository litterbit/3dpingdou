import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { detectGrid, fullRoi } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

function render(scores: number[], threshold: number, columns: number, rows: number, path: string) {
  const scale = 8;
  const png = new PNG({ width: columns * scale, height: rows * scale });
  scores.forEach((score, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const occupied = score > threshold;
    for (let y = 0; y < scale; y += 1) {
      for (let x = 0; x < scale; x += 1) {
        const p = ((row * scale + y) * png.width + column * scale + x) * 4;
        const [r, g, b] = occupied ? [20, 93, 89] : [245, 245, 245];
        png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b; png.data[p + 3] = 255;
      }
    }
  });
  writeFileSync(path, PNG.sync.write(png));
}

it("threshold sweep", () => {
  for (const name of ["拼豆图纸1.png", "小黑图纸.png"]) {
    const raster = load(`inputs/${name}`);
    const detection = detectGrid(raster, fullRoi(raster));
    for (const t of [0.03, 0.06, 0.1]) {
      render(detection.scores, t, detection.columns, detection.rows, `outputs/sweep-${t}-${name}`);
      console.log(name, "t =", t, "occupied", detection.scores.filter((s) => s > t).length);
    }
  }
});
