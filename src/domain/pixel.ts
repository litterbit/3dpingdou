export interface Raster { width: number; height: number; data: Uint8ClampedArray; }
export interface Roi { x: number; y: number; width: number; height: number; }
export interface GridGeometry { originX: number; originY: number; cellWidth: number; cellHeight: number; }
export interface PixelCell { color: [number, number, number] | null; confidence: number; }
export interface PixelMatrix { rows: number; columns: number; cells: PixelCell[]; background: [number, number, number]; }
export interface OccupancyAnalysis { scores: number[]; threshold: number; occupancy: boolean[]; }
export interface GridDetection { roi: Roi; rows: number; columns: number; geometry: GridGeometry; confidence: number; scores: number[]; threshold: number; occupancy: boolean[]; }

// 中心像素与格子底色的颜色距离超过该值就视为“墨迹”（编号/符号）。
const INK_DISTANCE = 36;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const at = (raster: Raster, x: number, y: number) => (y * raster.width + x) * 4;
const distance = (a: readonly number[], b: readonly number[]) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function luminance(raster: Raster, x: number, y: number): number {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return raster.data[p] * 0.299 + raster.data[p + 1] * 0.587 + raster.data[p + 2] * 0.114;
}

function rgbAt(raster: Raster, x: number, y: number): [number, number, number] {
  const p = at(raster, clamp(Math.floor(x), 0, raster.width - 1), clamp(Math.floor(y), 0, raster.height - 1));
  return [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
}

function interp(values: readonly number[], position: number): number {
  if (!values.length) return 0;
  const low = clamp(Math.floor(position), 0, values.length - 1);
  const high = clamp(low + 1, 0, values.length - 1);
  const t = clamp(position - low, 0, 1);
  return values[low] * (1 - t) + values[high] * t;
}

export function fullRoi(raster: Raster): Roi {
  return { x: 0, y: 0, width: raster.width, height: raster.height };
}

export function normalizeRoi(raster: Raster, roi?: Roi | null): Roi {
  if (!roi) return fullRoi(raster);
  const x = clamp(Math.round(Math.min(roi.x, roi.x + roi.width)), 0, Math.max(0, raster.width - 8));
  const y = clamp(Math.round(Math.min(roi.y, roi.y + roi.height)), 0, Math.max(0, raster.height - 8));
  const right = clamp(Math.round(Math.max(roi.x, roi.x + roi.width)), x + 8, raster.width);
  const bottom = clamp(Math.round(Math.max(roi.y, roi.y + roi.height)), y + 8, raster.height);
  return { x, y, width: right - x, height: bottom - y };
}

// 沿某个轴对 ROI 做“暗度投影”。用中位数而不是平均值：
// 格线贯穿整张图纸（中位数会被抬高），而编号文字和豆子填色只覆盖部分行/列。
function projection(raster: Raster, roi: Roi, axis: "x" | "y"): number[] {
  const length = axis === "x" ? roi.width : roi.height;
  const cross = axis === "x" ? roi.height : roi.width;
  const step = Math.max(1, Math.ceil(cross / 480));
  const samples: number[] = [];
  const values = new Array<number>(length).fill(0);
  for (let position = 0; position < length; position += 1) {
    samples.length = 0;
    for (let other = 0; other < cross; other += step) {
      const x = axis === "x" ? roi.x + position : roi.x + other;
      const y = axis === "x" ? roi.y + other : roi.y + position;
      samples.push(255 - luminance(raster, x, y));
    }
    values[position] = median(samples);
  }
  return values;
}

function detrend(values: readonly number[]): number[] {
  const window = 41;
  return values.map((value, index) => {
    const start = Math.max(0, index - Math.floor(window / 2));
    const end = Math.min(values.length, index + Math.ceil(window / 2));
    let local = 0;
    for (let i = start; i < end; i += 1) local += values[i];
    return value - local / Math.max(1, end - start);
  });
}

function correlation(residual: readonly number[], lag: number): number {
  const limit = residual.length - Math.ceil(lag) - 1;
  let cross = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < limit; index += 1) {
    const a = residual[index];
    const b = interp(residual, index + lag);
    cross += a * b;
    left += a * a;
    right += b * b;
  }
  return cross / Math.max(1, Math.sqrt(left * right));
}

// 整数自相关找出候选周期，再在 ±1.5px 内做 0.05px 步长的亚像素细化。
// 21 px 与 21.4 px 在 49 列上差近 20 px，整数周期会让格线漂进格子中心。
function findPitch(values: readonly number[]): { pitch: number; score: number } {
  const residual = detrend(values);
  const maxLag = Math.min(64, Math.floor(values.length / 4));
  if (maxLag < 8) return { pitch: Math.max(4, maxLag) || 18, score: 0 };
  let bestScore = -Infinity;
  const scores: Array<{ lag: number; score: number }> = [];
  for (let lag = 8; lag <= maxLag; lag += 1) {
    const score = correlation(residual, lag);
    scores.push({ lag, score });
    if (score > bestScore) bestScore = score;
  }
  // 周期翻倍（2p）的自相关经常比基频还高，不能全局取最大。
  // 基频处一定存在局部极大值，所以取“得分不低于最强局部峰一半”的最小局部极大值。
  const localMaxima = scores.filter((item, index) => {
    const before = scores[index - 1]?.score ?? -Infinity;
    const after = scores[index + 1]?.score ?? -Infinity;
    return item.score > before && item.score >= after && item.score > 0;
  });
  const strongest = Math.max(0, ...localMaxima.map((item) => item.score));
  const chosen = (localMaxima.filter((item) => item.score >= strongest * 0.5).sort((a, b) => a.lag - b.lag)[0] ?? scores.find((item) => item.score === bestScore))?.lag ?? 18;
  let refined = chosen;
  let refinedScore = -Infinity;
  for (let lag = Math.max(6, chosen - 1.5); lag <= chosen + 1.5; lag += 0.05) {
    const score = correlation(residual, lag);
    if (score > refinedScore) { refinedScore = score; refined = lag; }
  }
  return { pitch: refined, score: refinedScore };
}

// 相位由格线决定而不是图案内容：候选相位下格线能量要高，穿过格子中心的暗线能量要低。
function findPhase(proj: readonly number[], pitch: number): number {
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = 0; offset < pitch; offset += 0.25) {
    let border = 0;
    let borderCount = 0;
    let center = 0;
    let centerCount = 0;
    for (let k = 0; ; k += 1) {
      const line = offset + k * pitch;
      if (line >= proj.length) break;
      border += interp(proj, line);
      borderCount += 1;
      const middle = line + pitch / 2;
      if (middle < proj.length) {
        center += interp(proj, middle);
        centerCount += 1;
      }
    }
    const score = border / Math.max(1, borderCount) - 0.5 * (center / Math.max(1, centerCount));
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  return bestOffset;
}

interface CellInk { score: number; base: [number, number, number]; }

// 每格先用自己的四角估计底色，再统计中心区域与底色差异超过阈值的像素比例。
// 黑底白字、白底灰字、红底浅字都能识别，因为比较的是距离而不是明暗。
function cellInk(raster: Raster, left: number, top: number, right: number, bottom: number): CellInk {
  const width = right - left;
  const height = bottom - top;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const collect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
      for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
        const color = rgbAt(raster, x, y);
        red.push(color[0]);
        green.push(color[1]);
        blue.push(color[2]);
      }
    }
  };
  // 四角 14%..34%，避开格线。
  collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
  collect(right - width * 0.34, top + height * 0.14, right - width * 0.14, top + height * 0.34);
  collect(left + width * 0.14, bottom - height * 0.34, left + width * 0.34, bottom - height * 0.14);
  collect(right - width * 0.34, bottom - height * 0.34, right - width * 0.14, bottom - height * 0.14);
  const base: [number, number, number] = [median(red), median(green), median(blue)];
  let ink = 0;
  let total = 0;
  const centerLeft = left + width * 0.24;
  const centerRight = left + width * 0.76;
  const centerTop = top + height * 0.24;
  const centerBottom = top + height * 0.76;
  for (let y = clamp(Math.ceil(centerTop), 0, raster.height - 1); y <= clamp(Math.floor(centerBottom), 0, raster.height - 1); y += 1) {
    for (let x = clamp(Math.ceil(centerLeft), 0, raster.width - 1); x <= clamp(Math.floor(centerRight), 0, raster.width - 1); x += 1) {
      total += 1;
      if (distance(rgbAt(raster, x, y), base) > INK_DISTANCE) ink += 1;
    }
  }
  return { score: total ? ink / total : 0, base };
}

// Otsu：把全部格子的 inkRatio 自动分成“空白 / 有编号”两类，不写死阈值。
export function otsuThreshold(values: readonly number[]): number {
  if (!values.length) return 0;
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 1e-6) return 0;
  const BINS = 64;
  const histogram = new Array<number>(BINS).fill(0);
  for (const value of values) histogram[Math.min(BINS - 1, Math.floor((value / max) * (BINS - 1e-9)))] += 1;
  const total = values.length;
  let sumTotal = 0;
  for (let i = 0; i < BINS; i += 1) sumTotal += i * histogram[i];
  let weightBackground = 0;
  let sumBackground = 0;
  let bestBin = 0;
  let bestVariance = -Infinity;
  for (let bin = 0; bin < BINS; bin += 1) {
    weightBackground += histogram[bin];
    sumBackground += bin * histogram[bin];
    const weightForeground = total - weightBackground;
    if (!weightBackground || !weightForeground) continue;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumTotal - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) { bestVariance = variance; bestBin = bin; }
  }
  return ((bestBin + 1) / BINS) * max;
}

export function applyThreshold(scores: readonly number[], threshold: number): boolean[] {
  return scores.map((score) => score > threshold);
}

export function analyzeOccupancy(raster: Raster, geometry: GridGeometry, rows: number, columns: number): OccupancyAnalysis {
  const scores: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = geometry.originX + column * geometry.cellWidth;
      const top = geometry.originY + row * geometry.cellHeight;
      scores.push(cellInk(raster, left, top, left + geometry.cellWidth, top + geometry.cellHeight).score);
    }
  }
  const threshold = otsuThreshold(scores);
  return { scores, threshold, occupancy: applyThreshold(scores, threshold) };
}

function trimAnalysis(geometry: GridGeometry, rows: number, columns: number, analysis: OccupancyAnalysis): { geometry: GridGeometry; rows: number; columns: number; analysis: OccupancyAnalysis } {
  let rowMin = rows;
  let rowMax = -1;
  let colMin = columns;
  let colMax = -1;
  analysis.occupancy.forEach((occupied, index) => {
    if (!occupied) return;
    const row = Math.floor(index / columns);
    const column = index % columns;
    rowMin = Math.min(rowMin, row);
    rowMax = Math.max(rowMax, row);
    colMin = Math.min(colMin, column);
    colMax = Math.max(colMax, column);
  });
  if (rowMax < 0) return { geometry, rows, columns, analysis };
  const nextRows = rowMax - rowMin + 1;
  const nextColumns = colMax - colMin + 1;
  if (nextRows === rows && nextColumns === columns) return { geometry, rows, columns, analysis };
  const scores: number[] = [];
  const occupancy: boolean[] = [];
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let column = colMin; column <= colMax; column += 1) {
      scores.push(analysis.scores[row * columns + column]);
      occupancy.push(analysis.occupancy[row * columns + column]);
    }
  }
  return {
    geometry: { ...geometry, originX: geometry.originX + colMin * geometry.cellWidth, originY: geometry.originY + rowMin * geometry.cellHeight },
    rows: nextRows,
    columns: nextColumns,
    analysis: { scores, threshold: analysis.threshold, occupancy },
  };
}

// 完整自动流程：ROI 内投影 → 亚像素周期 → 格线能量定相位 → inkRatio + Otsu → 裁剪到有效格外接框。
export function detectGrid(raster: Raster, roi?: Roi | null): GridDetection {
  const region = normalizeRoi(raster, roi);
  const projectionX = projection(raster, region, "x");
  const projectionY = projection(raster, region, "y");
  const pitchX = findPitch(projectionX);
  const pitchY = findPitch(projectionY);
  const originX = region.x + findPhase(projectionX, pitchX.pitch);
  const originY = region.y + findPhase(projectionY, pitchY.pitch);
  const columns = Math.max(1, Math.round((region.x + region.width - originX) / pitchX.pitch));
  const rows = Math.max(1, Math.round((region.y + region.height - originY) / pitchY.pitch));
  const geometry: GridGeometry = { originX, originY, cellWidth: pitchX.pitch, cellHeight: pitchY.pitch };
  const trimmed = trimAnalysis(geometry, rows, columns, analyzeOccupancy(raster, geometry, rows, columns));
  return {
    roi: region,
    rows: trimmed.rows,
    columns: trimmed.columns,
    geometry: trimmed.geometry,
    confidence: clamp((pitchX.score + pitchY.score) / 2, 0, 1),
    scores: trimmed.analysis.scores,
    threshold: trimmed.analysis.threshold,
    occupancy: trimmed.analysis.occupancy,
  };
}

// 占位确定后的颜色采样：去掉边缘 16%（格线）和中心 28%..72%（编号），取剩余环形区域的中位数。
export function sampleCellColor(raster: Raster, geometry: GridGeometry, row: number, column: number): [number, number, number] {
  const left = geometry.originX + column * geometry.cellWidth;
  const top = geometry.originY + row * geometry.cellHeight;
  const width = geometry.cellWidth;
  const height = geometry.cellHeight;
  const innerLeft = left + width * 0.16;
  const innerRight = left + width * 0.84;
  const innerTop = top + height * 0.16;
  const innerBottom = top + height * 0.84;
  const centerLeft = left + width * 0.28;
  const centerRight = left + width * 0.72;
  const centerTop = top + height * 0.28;
  const centerBottom = top + height * 0.72;
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = clamp(Math.ceil(innerTop), 0, raster.height - 1); y <= clamp(Math.floor(innerBottom), 0, raster.height - 1); y += 1) {
    for (let x = clamp(Math.ceil(innerLeft), 0, raster.width - 1); x <= clamp(Math.floor(innerRight), 0, raster.width - 1); x += 1) {
      if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) continue;
      const color = rgbAt(raster, x, y);
      red.push(color[0]);
      green.push(color[1]);
      blue.push(color[2]);
    }
  }
  return [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))];
}

export function recognizeMatrix(raster: Raster, detection: Pick<GridDetection, "rows" | "columns" | "geometry"> & { occupancy?: boolean[] }, _backgroundCell = 0): PixelMatrix {
  const analysis = detection.occupancy ? null : analyzeOccupancy(raster, detection.geometry, detection.rows, detection.columns);
  const occupancy = detection.occupancy ?? analysis?.occupancy ?? [];
  const cells = Array.from({ length: detection.rows * detection.columns }, (_, index) => {
    const row = Math.floor(index / detection.columns);
    const column = index % detection.columns;
    const confidence = analysis?.scores[index] ?? 1;
    return occupancy[index]
      ? { color: sampleCellColor(raster, detection.geometry, row, column), confidence }
      : { color: null, confidence };
  });
  return { rows: detection.rows, columns: detection.columns, background: [255, 255, 255], cells };
}

export function renderMatrix(matrix: PixelMatrix): ImageData {
  const image = typeof ImageData === "function" ? new ImageData(matrix.columns, matrix.rows) : ({ width: matrix.columns, height: matrix.rows, data: new Uint8ClampedArray(matrix.columns * matrix.rows * 4) } as ImageData);
  matrix.cells.forEach((cell, index) => {
    if (!cell.color) return;
    const p = index * 4;
    image.data[p] = cell.color[0];
    image.data[p + 1] = cell.color[1];
    image.data[p + 2] = cell.color[2];
    image.data[p + 3] = 255;
  });
  return image;
}

export function colorKey(color: readonly number[] | null): string {
  return color ? color.join(",") : "empty";
}
