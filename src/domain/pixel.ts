export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GridGeometry {
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
}

export interface GridDetection {
  rows: number;
  columns: number;
  geometry: GridGeometry;
  confidence: number;
}

export interface PixelCell {
  color: [number, number, number] | null;
  confidence: number;
}

export interface PixelMatrix {
  rows: number;
  columns: number;
  cells: PixelCell[];
  background: [number, number, number];
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function offset(raster: Raster, x: number, y: number): number {
  return (y * raster.width + x) * 4;
}

function rgbDistance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function axisEdges(raster: Raster, axis: "x" | "y"): number[] {
  const length = axis === "x" ? raster.width : raster.height;
  const cross = axis === "x" ? raster.height : raster.width;
  const scores = Array.from({ length }, () => 0);
  for (let position = 1; position < length; position += 1) {
    let changed = 0;
    for (let other = 0; other < cross; other += 1) {
      const x = axis === "x" ? position : other;
      const y = axis === "x" ? other : position;
      const left = offset(raster, x - (axis === "x" ? 1 : 0), y - (axis === "y" ? 1 : 0));
      const current = offset(raster, x, y);
      const difference = Math.max(
        Math.abs(raster.data[current] - raster.data[left]),
        Math.abs(raster.data[current + 1] - raster.data[left + 1]),
        Math.abs(raster.data[current + 2] - raster.data[left + 2]),
      );
      if (difference >= 10) changed += 1;
    }
    scores[position] = changed / cross;
  }
  return scores;
}

function bestPeriod(scores: readonly number[]): { phase: number; pitch: number; score: number } {
  const maxPitch = Math.min(128, Math.floor(scores.length / 4));
  const candidates: Array<{ phase: number; pitch: number; score: number }> = [];
  for (let pitch = 8; pitch <= maxPitch; pitch += 1) {
    for (let phase = 0; phase < pitch; phase += 1) {
      let total = 0;
      let count = 0;
      for (let point = phase; point < scores.length; point += pitch) {
        total += scores[point];
        count += 1;
      }
      const score = total / Math.max(1, count);
      candidates.push({ phase, pitch, score });
    }
  }
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score), 0);
  return candidates
    .filter((candidate) => candidate.score >= bestScore * 0.82)
    .sort((a, b) => a.pitch - b.pitch || b.score - a.score)[0] ?? {
      phase: 0,
      pitch: Math.max(8, Math.floor(scores.length / 20)),
      score: 0,
    };
}

export function detectGrid(raster: Raster): GridDetection {
  if (!raster.width || !raster.height) throw new Error("图片为空");
  const horizontal = axisEdges(raster, "y");
  const vertical = axisEdges(raster, "x");
  const x = bestPeriod(vertical);
  const y = bestPeriod(horizontal);
  const pitch = (x.pitch + y.pitch) / 2;
  // The edge projection peaks on the first pixel after a one-pixel guide line.
  // Move that peak back to the actual cell boundary so the outer cells remain included.
  const originX = Math.max(0, x.phase - 1);
  const originY = Math.max(0, y.phase - 1);
  const columns = Math.max(1, Math.floor((raster.width - originX) / x.pitch));
  const rows = Math.max(1, Math.floor((raster.height - originY) / y.pitch));
  const confidence = Math.min(0.99, Math.max(0.05, (x.score + y.score) / 2));
  return {
    rows,
    columns,
    geometry: { originX, originY, cellWidth: x.pitch, cellHeight: y.pitch },
    confidence: Number.isFinite(pitch) ? confidence : 0,
  };
}

export function sampleCell(raster: Raster, geometry: GridGeometry, row: number, column: number): PixelCell {
  const left = Math.floor(geometry.originX + column * geometry.cellWidth + geometry.cellWidth * 0.22);
  const right = Math.ceil(geometry.originX + (column + 1) * geometry.cellWidth - geometry.cellWidth * 0.22);
  const top = Math.floor(geometry.originY + row * geometry.cellHeight + geometry.cellHeight * 0.22);
  const bottom = Math.ceil(geometry.originY + (row + 1) * geometry.cellHeight - geometry.cellHeight * 0.22);
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = clamp(top, 0, raster.height - 1); y < clamp(bottom, 1, raster.height); y += 1) {
    for (let x = clamp(left, 0, raster.width - 1); x < clamp(right, 1, raster.width); x += 1) {
      const value = offset(raster, x, y);
      if (raster.data[value + 3] >= 32) {
        red.push(raster.data[value]);
        green.push(raster.data[value + 1]);
        blue.push(raster.data[value + 2]);
      }
    }
  }
  if (!red.length) return { color: null, confidence: 0.9 };
  return {
    color: [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))],
    confidence: Math.min(1, red.length / 80),
  };
}

export function recognizeMatrix(
  raster: Raster,
  detection: Pick<GridDetection, "rows" | "columns" | "geometry">,
  backgroundCell: number,
  emptyThreshold = 28,
): PixelMatrix {
  const cells = Array.from({ length: detection.rows * detection.columns }, (_, index) =>
    sampleCell(raster, detection.geometry, Math.floor(index / detection.columns), index % detection.columns),
  );
  const background = cells[backgroundCell]?.color ?? [255, 255, 255];
  return {
    rows: detection.rows,
    columns: detection.columns,
    background,
    cells: cells.map((cell) => ({
      ...cell,
      color: cell.color && rgbDistance(cell.color, background) <= emptyThreshold ? null : cell.color,
    })),
  };
}

export function renderMatrix(matrix: PixelMatrix): ImageData {
  const image = new ImageData(matrix.columns, matrix.rows);
  matrix.cells.forEach((cell, index) => {
    const at = index * 4;
    if (cell.color) {
      image.data[at] = cell.color[0];
      image.data[at + 1] = cell.color[1];
      image.data[at + 2] = cell.color[2];
      image.data[at + 3] = 255;
    }
  });
  return image;
}

export function colorKey(color: readonly number[] | null): string {
  return color ? color.join(",") : "empty";
}
