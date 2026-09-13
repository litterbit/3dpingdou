import { describe, expect, it } from "vitest";
import { detectGrid, recognizeMatrix, renderMatrix, replaceMatrixColor } from "../src/domain/pixel";
import type { PixelMatrix } from "../src/domain/pixel";
import { makeNumberedGridFixture } from "./helpers/beadFixtures";
import { makeGuidedNumberedChart } from "./helpers/chartFixtures";

describe("numbered bead chart recognition", () => {
  it("uses the full numbered-cell pitch instead of a smaller color period", () => {
    const raster = makeNumberedGridFixture({ rows: 5, columns: 7, whiteBeadCells: [8] });
    const result = detectGrid(raster);
    expect(result.rows).toBe(5);
    expect(result.columns).toBe(7);
    expect(result.geometry.cellWidth).toBeCloseTo(18, 0);
    expect(result.geometry.cellHeight).toBeCloseTo(18, 0);
  });

  it("uses the center label to distinguish empty cells from light occupied cells", () => {
    const raster = makeNumberedGridFixture({ rows: 4, columns: 5, whiteBeadCells: [1] });
    const detection = detectGrid(raster);
    const result = recognizeMatrix(raster, detection, 0);
    expect(result.cells[0].color).toBeNull();
    expect(result.cells[1].color).toEqual([255, 255, 255]);
    expect(detection.occupancy[0]).toBe(false);
    expect(detection.occupancy[1]).toBe(true);
  });

  it("renders occupied colors as opaque pixels and empty cells as transparent pixels", () => {
    const raster = makeNumberedGridFixture({ rows: 2, columns: 3 });
    const detection = detectGrid(raster);
    const result = recognizeMatrix(raster, { ...detection, occupancy: detection.occupancy.map((_occupied, index) => index === 0 ? false : true) }, 0);
    const image = renderMatrix(result);
    expect(image.data[3]).toBe(0);
    expect(image.data[(1 * 4) + 3]).toBe(255);
  });

  it("keeps the data matrix when a chart has coordinate guides around it", () => {
    const fixture = makeGuidedNumberedChart(8, 6);
    const result = detectGrid(fixture.raster);
    expect(result.rows).toBeGreaterThanOrEqual(8);
    expect(result.columns).toBeGreaterThanOrEqual(6);
    expect(result.geometry.cellWidth).toBeCloseTo(18, 0);
    expect(result.geometry.cellHeight).toBeCloseTo(18, 0);
  });
});

describe("replaceMatrixColor", () => {
  const matrix: PixelMatrix = {
    rows: 2,
    columns: 2,
    background: [255, 255, 255],
    cells: [
      { color: [200, 30, 30], confidence: 1 },
      { color: [30, 30, 200], confidence: 1 },
      { color: null, confidence: 1 },
      { color: [200, 30, 30], confidence: 1 },
    ],
  };

  it("replaces every cell matching the source color and keeps the rest", () => {
    const result = replaceMatrixColor(matrix, [200, 30, 30], [10, 180, 90]);
    expect(result.cells[0].color).toEqual([10, 180, 90]);
    expect(result.cells[3].color).toEqual([10, 180, 90]);
    expect(result.cells[1].color).toEqual([30, 30, 200]);
    expect(result.cells[2].color).toBeNull();
  });

  it("returns the same matrix when the color is absent or unchanged", () => {
    expect(replaceMatrixColor(matrix, [1, 2, 3], [10, 180, 90])).toBe(matrix);
    expect(replaceMatrixColor(matrix, [200, 30, 30], [200, 30, 30])).toBe(matrix);
  });
});
