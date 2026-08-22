import { describe, expect, it } from "vitest";
import { detectGrid, recognizeMatrix, sampleCell, type Raster } from "../src/domain/pixel";

function makeChart(rows: number, columns: number, pitch = 12): Raster {
  const width = columns * pitch;
  const height = rows * pitch;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / pitch) + Math.floor(y / pitch)) % 3;
      const color: [number, number, number] = cell === 0 ? [245, 245, 245] : cell === 1 ? [25, 100, 130] : [220, 80, 45];
      const line = x % pitch === 0 || y % pitch === 0;
      const at = (y * width + x) * 4;
      data[at] = line ? 40 : color[0];
      data[at + 1] = line ? 110 : color[1];
      data[at + 2] = line ? 105 : color[2];
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("pixel chart recognition", () => {
  it("detects a repeated square grid", () => {
    const raster = makeChart(5, 7);
    const result = detectGrid(raster);
    expect(result.rows).toBe(5);
    expect(result.columns).toBe(7);
    expect(result.geometry.cellWidth).toBe(12);
    expect(result.geometry.cellHeight).toBe(12);
  });

  it("samples the inside of a cell instead of its grid line", () => {
    const raster = makeChart(2, 2);
    expect(sampleCell(raster, { originX: 0, originY: 0, cellWidth: 12, cellHeight: 12 }, 0, 1).color).toEqual([25, 100, 130]);
  });

  it("makes the selected background transparent while preserving other colors", () => {
    const raster = makeChart(2, 2);
    const result = recognizeMatrix(raster, { rows: 2, columns: 2, geometry: { originX: 0, originY: 0, cellWidth: 12, cellHeight: 12 } }, 0);
    expect(result.cells[0].color).toBeNull();
    expect(result.cells[1].color).not.toBeNull();
  });
});
