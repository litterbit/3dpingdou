import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { detectGrid, fullRoi, recognizeMatrix, renderMatrix } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

function save(path: string, width: number, height: number, data: Uint8ClampedArray) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data);
  writeFileSync(path, PNG.sync.write(png));
}

it("render occupancy and colors for real charts", () => {
  for (const name of ["拼豆图纸1.png", "小黑图纸.png", "屏幕截图 2026-08-22 194733.png"]) {
    const raster = load(`inputs/${name}`);
    const detection = detectGrid(raster, fullRoi(raster));
    const scale = 8;
    const occ = new PNG({ width: detection.columns * scale, height: detection.rows * scale });
    detection.occupancy.forEach((occupied, index) => {
      const row = Math.floor(index / detection.columns);
      const column = index % detection.columns;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const p = ((row * scale + y) * occ.width + column * scale + x) * 4;
          const [r, g, b] = occupied ? [20, 93, 89] : [245, 245, 245];
          occ.data[p] = r; occ.data[p + 1] = g; occ.data[p + 2] = b; occ.data[p + 3] = 255;
        }
      }
    });
    writeFileSync(`outputs/debug-occ-${name}`, PNG.sync.write(occ));

    const matrix = recognizeMatrix(raster, detection);
    const image = renderMatrix(matrix);
    save(`outputs/debug-color-${name}`, matrix.columns, matrix.rows, image.data);
    console.log(name, `${detection.columns}x${detection.rows}`, `occupied ${detection.occupancy.filter(Boolean).length}`);
  }
});
