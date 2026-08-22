import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { it } from "vitest";
import { detectGrid, fullRoi } from "../src/domain/pixel";

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

it("inspect edge scores", () => {
  const raster = load("inputs/拼豆图纸1.png");
  const detection = detectGrid(raster, fullRoi(raster));
  const { columns, rows, scores } = detection;
  console.log("grid", columns, "x", rows);
  for (let row = 0; row < rows; row += 1) {
    const line: string[] = [];
    for (let column = 0; column < Math.min(6, columns); column += 1) line.push(scores[row * columns + column].toFixed(2));
    console.log(row, line.join(" "));
  }
});
