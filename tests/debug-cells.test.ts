import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { detectGrid, fullRoi } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

// 在原图上叠加检测结果：分数热力（绿=高分，红=低分但>0），蓝框=判为有豆。
// 同时把分数矩阵打到控制台，便于逐格核对。
it("cell score overlay", () => {
  for (const name of ["拼豆图纸1.png", "屏幕截图 2026-08-22 194733.png"]) {
    const raster = load(`inputs/${name}`);
    const detection = detectGrid(raster, fullRoi(raster));
    const { geometry, rows, columns, scores, occupancy, threshold } = detection;
    const out = new PNG({ width: raster.width, height: raster.height });
    raster.data.forEach((v, i) => { out.data[i] = v; });
    for (let row = 0; row < rows; row += 1) {
      let line = "";
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const score = scores[index];
        line += `${score.toFixed(2)}${occupancy[index] ? "*" : " "} `;
        const left = Math.round(geometry.originX + column * geometry.cellWidth);
        const top = Math.round(geometry.originY + row * geometry.cellHeight);
        const right = Math.round(geometry.originX + (column + 1) * geometry.cellWidth);
        const bottom = Math.round(geometry.originY + (row + 1) * geometry.cellHeight);
        const heat = Math.min(1, score / 0.6);
        const fill: [number, number, number] = score === 0
          ? [0, 0, 0]
          : [Math.round(255 * (1 - heat)), Math.round(255 * heat), 0];
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
            const p = (y * raster.width + x) * 4;
            const border = x === left || y === top;
            if (border && occupancy[index]) { out.data[p] = 0; out.data[p + 1] = 80; out.data[p + 2] = 255; continue; }
            if (score > 0) {
              out.data[p] = Math.round(out.data[p] * 0.5 + fill[0] * 0.5);
              out.data[p + 1] = Math.round(out.data[p + 1] * 0.5 + fill[1] * 0.5);
              out.data[p + 2] = Math.round(out.data[p + 2] * 0.5 + fill[2] * 0.5);
            }
          }
        }
      }
      if (row < 8 || row >= rows - 8) console.log(name, `r${row}`, line);
    }
    console.log(name, `threshold=${threshold.toFixed(3)} ${columns}x${rows} origin=${geometry.originX.toFixed(1)},${geometry.originY.toFixed(1)} pitch=${geometry.cellWidth.toFixed(2)}x${geometry.cellHeight.toFixed(2)}`);
    writeFileSync(`outputs/debug-cells-${name}`, PNG.sync.write(out));
  }
});
