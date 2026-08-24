import type { GridGeometry, Raster } from "../../src/domain/pixel";
import { makeRaster, setPixel } from "./beadFixtures";

const OPAQUE = 255;

export function makeGuidedNumberedChart(
  rows = 24,
  columns = 16,
  trailingGuideRows = 0,
): {
  raster: Raster;
  expectedGeometry: GridGeometry;
  decorationCell: number;
  paleBeadCell: number;
} {
  const stride = 18;
  const guideColumns = 8;
  const rowLabelColumn = guideColumns;
  const dataColumnOffset = rowLabelColumn + 1;
  const sheetColumns = dataColumnOffset + columns;
  const sheetRows = rows + 1 + trailingGuideRows;
  const page = [247, 204, 161, OPAQUE] as const;
  const grid = [35, 35, 35, OPAQUE] as const;
  const raster = makeRaster(
    sheetColumns * stride,
    sheetRows * stride,
    page,
  );

  // The photographed sheet loses the two outer vertical borders and the
  // bottom border, while every interior line remains visible.
  for (let row = 0; row < sheetRows; row += 1) {
    const y = row * stride;
    for (let x = 0; x < raster.width; x += 1) {
      setPixel(raster, x, y, grid);
      setPixel(raster, x, y + 1, grid);
    }
  }
  for (let column = 1; column < sheetColumns; column += 1) {
    const x = column * stride;
    for (let y = 0; y < raster.height; y += 1) {
      setPixel(raster, x, y, grid);
      setPixel(raster, x + 1, y, grid);
    }
  }

  const drawLabel = (row: number, column: number): void => {
    const centreX = column * stride + Math.floor(stride / 2);
    const centreY = row * stride + Math.floor(stride / 2);
    for (let delta = -3; delta <= 3; delta += 1) {
      setPixel(raster, centreX + delta, centreY, grid);
      setPixel(raster, centreX, centreY + delta, grid);
    }
  };
  for (let row = 0; row < rows; row += 1) {
    drawLabel(row, rowLabelColumn);
  }
  for (let column = 0; column < columns; column += 1) {
    drawLabel(rows, dataColumnOffset + column);
  }

  const paleBeadCell = columns * 10 + 7;
  const decorationCell = columns - 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cellIndex = row * columns + column;
      if (cellIndex === 0 || (row < 2 && column < 5)) {
        continue;
      }
      if (cellIndex === decorationCell) {
        const left = (dataColumnOffset + column) * stride + 2;
        const top = row * stride + 2;
        const right = (dataColumnOffset + column + 1) * stride;
        const bottom = (row + 1) * stride;
        for (let y = top; y < bottom; y += 1) {
          const normalizedY = (y - top) / Math.max(1, bottom - top - 1);
          const wedgeWidth = Math.round(
            5 + Math.abs(normalizedY - 0.5) * 8,
          );
          for (let x = right - wedgeWidth; x < right; x += 1) {
            setPixel(raster, x, y, [200, 135, 95, OPAQUE]);
          }
        }
        continue;
      }
      const fill =
        cellIndex === paleBeadCell
          ? ([248, 202, 160, OPAQUE] as const)
          : (row * 7 + column * 3) % 13 === 0
            ? ([55, 55, 55, OPAQUE] as const)
            : ([95, 155, 105, OPAQUE] as const);
      const left = (dataColumnOffset + column) * stride + 2;
      const top = row * stride + 2;
      const right = (dataColumnOffset + column + 1) * stride;
      const bottom = (row + 1) * stride;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          setPixel(raster, x, y, fill);
        }
      }
      drawLabel(row, dataColumnOffset + column);
    }
  }

  return {
    raster,
    expectedGeometry: {
      originX: dataColumnOffset * stride,
      originY: 0,
      cellWidth: stride,
      cellHeight: stride,
    },
    decorationCell,
    paleBeadCell,
  };
}
