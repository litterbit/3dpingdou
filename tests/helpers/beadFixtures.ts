import type { Raster } from "../../src/domain/pixel";

export type RgbColor = [number, number, number];

const OPAQUE = 255;

export function makeRaster(
  width: number,
  height: number,
  color: readonly [number, number, number, number] = [
    250,
    250,
    250,
    OPAQUE,
  ],
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }
  return { width, height, data };
}

export function setPixel(
  raster: Raster,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
    return;
  }
  const offset = (y * raster.width + x) * 4;
  raster.data[offset] = color[0];
  raster.data[offset + 1] = color[1];
  raster.data[offset + 2] = color[2];
  raster.data[offset + 3] = color[3];
}

function fillRect(
  raster: Raster,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      setPixel(raster, x, y, color);
    }
  }
}

function rgba(color: RgbColor, alpha = OPAQUE) {
  return [color[0], color[1], color[2], alpha] as const;
}

export interface NumberedGridFixtureOptions {
  rows: number;
  columns: number;
  gridLineWidth?: number;
  watermarkCells?: number[];
  whiteBeadCells?: number[];
}

export function makeNumberedGridFixture({
  rows,
  columns,
  gridLineWidth = 2,
  watermarkCells = [],
  whiteBeadCells = [],
}: NumberedGridFixtureOptions): Raster {
  const stride = 18;
  const raster = makeRaster(
    columns * stride + gridLineWidth,
    rows * stride + gridLineWidth,
    [244, 244, 244, OPAQUE],
  );
  const grid = [35, 35, 35, OPAQUE] as const;
  const palette: RgbColor[] = [
    [230, 40, 50],
    [30, 110, 220],
    [245, 190, 35],
  ];

  for (let row = 0; row <= rows; row += 1) {
    fillRect(
      raster,
      0,
      row * stride,
      raster.width,
      row * stride + gridLineWidth,
      grid,
    );
  }
  for (let column = 0; column <= columns; column += 1) {
    fillRect(
      raster,
      column * stride,
      0,
      column * stride + gridLineWidth,
      raster.height,
      grid,
    );
  }

  for (let cellIndex = 1; cellIndex < rows * columns; cellIndex += 1) {
    const row = Math.floor(cellIndex / columns);
    const column = cellIndex % columns;
    const fill = whiteBeadCells.includes(cellIndex)
      ? ([255, 255, 255] as RgbColor)
      : palette[cellIndex % palette.length];
    const left = column * stride + gridLineWidth + 1;
    const top = row * stride + gridLineWidth + 1;
    const right = (column + 1) * stride - 1;
    const bottom = (row + 1) * stride - 1;
    fillRect(raster, left, top, right, bottom, rgba(fill));

    const centreX = Math.floor((left + right) / 2);
    const centreY = Math.floor((top + bottom) / 2);
    for (let delta = -2; delta <= 2; delta += 1) {
      setPixel(raster, centreX + delta, centreY, grid);
      setPixel(raster, centreX, centreY + delta, grid);
    }
  }

  for (const cellIndex of watermarkCells) {
    const row = Math.floor(cellIndex / columns);
    const column = cellIndex % columns;
    const left = column * stride + gridLineWidth + 1;
    const top = row * stride + gridLineWidth + 1;
    for (let delta = 0; delta < stride - 5; delta += 1) {
      for (let thickness = -3; thickness <= 3; thickness += 1) {
        setPixel(
          raster,
          left + delta,
          top + delta + thickness,
          delta % 2 === 0
            ? [170, 20, 190, OPAQUE]
            : [15, 15, 15, OPAQUE],
        );
      }
    }
  }
  return raster;
}
