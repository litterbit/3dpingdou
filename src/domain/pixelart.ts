// 像素图模式：处理无格线、块大小不均、带抗锯齿的放大像素截图。
// 移植自 perfectPixel（perfect_pixel_noCV2.py）的三步管线：
//   1. FFT 频谱峰估计网格数（失败回退梯度间隔法）
//   2. 从中心向两侧贪心生长网格线，每条线吸附到最近的 Sobel 梯度峰
//   3. 逐格中位数采样 → 背景洪水填充置空 → 颜色量化
// 与图纸模式（grid.ts/occupancy.ts）互补：那边依赖逐格印刷结构，这里完全不假设格线存在。

import { fft2Magnitude } from "./fft";
import { clamp, distance, luminance, median, rgbAt } from "./helpers";
import { quantizeColors, rgbToLab } from "./quantize";
import { normalizeRoi } from "./roi";
import type { GridGeometry, PixelCell, PixelMatrix, Raster, Roi } from "./types";

export interface PixelArtDetection {
  matrix: PixelMatrix;
  rows: number;
  columns: number;
  geometry: GridGeometry;
  confidence: number;
}

interface Gray { data: Float64Array; width: number; height: number }

// FFT 估计在 ≤512px 的降采样灰度图上做：格子数 = 尺寸/周期，与缩放无关，结果直接可用。
function toGray(raster: Raster, roi: Roi, maxSize = 512): Gray {
  const scale = Math.min(1, maxSize / Math.max(roi.width, roi.height));
  const width = Math.max(8, Math.round(roi.width * scale));
  const height = Math.max(8, Math.round(roi.height * scale));
  const data = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = luminance(raster, roi.x + (x + 0.5) / scale, roi.y + (y + 0.5) / scale);
    }
  }
  return { data, width, height };
}

function normalizeMinmax(values: Float64Array): Float64Array {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx - mn < 1e-8) return new Float64Array(values.length);
  return values.map((v) => (v - mn) / (mx - mn));
}

function smooth1d(values: Float64Array, k = 17): Float64Array {
  if (k < 3) return values;
  if (k % 2 === 0) k += 1;
  const sigma = k / 6;
  const kernel: number[] = [];
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x = i - Math.floor(k / 2);
    const w = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let acc = 0;
    let weight = 0;
    for (let j = 0; j < k; j++) {
      const index = i + j - Math.floor(k / 2);
      if (index < 0 || index >= values.length) continue;
      acc += values[index] * kernel[j];
      weight += kernel[j];
    }
    out[i] = acc / Math.max(1e-8, weight);
  }
  return out;
}

// 宽峰检测：周期 p 的图案在长度 N 的频谱 ±N/p 处成对出峰，峰距之半 = 格子数。
// 照抄 perfectPixel：候选必须在中心两侧的 (0.25c, c-6) / (c+6, 1.75c) 区间，
// 分数取左右连续爬升/下降幅度的较大者。
function detectPeak(proj: Float64Array, peakWidth = 6, relThr = 0.35, minDist = 6): number | null {
  const center = Math.floor(proj.length / 2);
  let mx = 0;
  for (const v of proj) if (v > mx) mx = v;
  if (mx < 1e-6) return null;
  const thr = mx * relThr;
  const candidates: Array<{ index: number; score: number }> = [];
  for (let i = 1; i < proj.length - 1; i++) {
    let isPeak = true;
    for (let j = 1; j < peakWidth; j++) {
      if (i - j < 0 || i + j >= proj.length) continue;
      if (proj[i - j + 1] < proj[i - j] || proj[i + j - 1] < proj[i + j]) { isPeak = false; break; }
    }
    if (!isPeak || proj[i] < thr) continue;
    // 分数 = 峰顶到连续爬升/下降段端点的总落差（不是单步差）。
    let climb = 0;
    for (let k = i; k > 0; k--) {
      if (proj[k] > proj[k - 1]) climb = Math.abs(proj[i] - proj[k - 1]);
      else break;
    }
    let fall = 0;
    for (let k = i; k < proj.length - 1; k++) {
      if (proj[k] > proj[k + 1]) fall = Math.abs(proj[i] - proj[k + 1]);
      else break;
    }
    candidates.push({ index: i, score: Math.max(climb, fall) });
  }
  if (!candidates.length) return null;
  const left = candidates.filter((c) => c.index < center - minDist && c.index > center * 0.25).sort((a, b) => b.score - a.score);
  const right = candidates.filter((c) => c.index > center + minDist && c.index < center * 1.75).sort((a, b) => b.score - a.score);
  if (!left.length || !right.length) return null;
  return Math.abs(right[0].index - left[0].index) / 2;
}

// Sobel 3×3 梯度按轴求和投影（原图 ROI 局部坐标），与 perfectPixel 的 sobel_xy 一致。
function gradientProjections(raster: Raster, roi: Roi): { x: Float64Array; y: Float64Array } {
  const projX = new Float64Array(roi.width);
  const projY = new Float64Array(roi.height);
  const lum = (x: number, y: number) => luminance(raster, roi.x + x, roi.y + y);
  for (let y = 1; y < roi.height - 1; y++) {
    for (let x = 1; x < roi.width - 1; x++) {
      const gx = Math.abs(lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1) - lum(x - 1, y - 1) - 2 * lum(x - 1, y) - lum(x - 1, y + 1));
      const gy = Math.abs(lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1) - lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1));
      projX[x] += gx;
      projY[y] += gy;
    }
  }
  return { x: projX, y: projY };
}

/** FFT 频谱估计格子数，失败返回 null。 */
function estimateGridFft(gray: Gray, peakWidth = 6): { columns: number; rows: number } | null {
  const { mag, width, height } = fft2Magnitude(gray.data, gray.width, gray.height);
  for (let i = 0; i < mag.length; i++) mag[i] = 1 - Math.log1p(mag[i]); // 反相对数谱，照抄 perfectPixel
  const norm = normalizeMinmax(mag);
  const rowSum = new Float64Array(height);
  const colSum = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rowSum[y] += norm[y * width + x];
      colSum[x] += norm[y * width + x];
    }
  }
  const scaleRow = detectPeak(smooth1d(normalizeMinmax(rowSum)), peakWidth);
  const scaleCol = detectPeak(smooth1d(normalizeMinmax(colSum)), peakWidth);
  if (scaleRow === null || scaleCol === null || scaleCol <= 0) return null;
  // 频谱与原图同尺寸：峰距之半直接就是格子数
  return { columns: Math.max(1, Math.round(scaleCol)), rows: Math.max(1, Math.round(scaleRow)) };
}

/** 回退：梯度投影局部峰的间距中位数 → 格子数。 */
function estimateGridGradient(projX: Float64Array, projY: Float64Array, relThr = 0.2): { columns: number; rows: number } | null {
  const peaks = (proj: Float64Array, size: number): number | null => {
    let mx = 0;
    for (const v of proj) if (v > mx) mx = v;
    const thr = relThr * mx;
    const positions: number[] = [];
    for (let i = 1; i < proj.length - 1; i++) {
      if (proj[i] > proj[i - 1] && proj[i] > proj[i + 1] && proj[i] >= thr) {
        if (!positions.length || i - positions[positions.length - 1] >= 4) positions.push(i);
      }
    }
    if (positions.length < 4) return null;
    const intervals: number[] = [];
    for (let i = 1; i < positions.length; i++) intervals.push(positions[i] - positions[i - 1]);
    return size / median(intervals);
  };
  const columns = peaks(projX, projX.length);
  const rows = peaks(projY, projY.length);
  if (columns === null || rows === null) return null;
  return { columns: Math.max(1, Math.round(columns)), rows: Math.max(1, Math.round(rows)) };
}

// 合理性校验：格子边长（降采样灰度图上）≥4px、两向周期比 ≤1.5（拼豆格近似正方形），
// 失败换梯度法。上限 30 是反垃圾保险（FFT 可能在噪点周期上出假峰，如伊布图 FFT 给出 302 列）。
// 两条路径给出的格子数都只是粗估：梯度法会漏检短边（局部颜色边界跨越行数少，投影弱），
// 所以最后用 comb 搜索在 ±40% 窗口内细化周期（谐波在窗口外，不会锁错倍频）。
function combEnergy(proj: Float64Array, pitch: number, offset: number): number {
  let sum = 0;
  let count = 0;
  for (let line = offset; line < proj.length; line += pitch) {
    const low = Math.floor(line);
    const t = line - low;
    const a = proj[clamp(low, 0, proj.length - 1)];
    const b = proj[clamp(low + 1, 0, proj.length - 1)];
    sum += a * (1 - t) + b * t;
    count++;
  }
  return count ? sum / count : 0;
}

function refinePitchByComb(proj: Float64Array, approxCell: number): number {
  let bestPitch = approxCell;
  let bestEnergy = -Infinity;
  const lo = approxCell * 0.7;
  const hi = approxCell * 1.4;
  for (let pitch = lo; pitch <= hi; pitch += 0.05) {
    const steps = Math.max(4, Math.round(pitch / 0.25));
    for (let s = 0; s < steps; s++) {
      const energy = combEnergy(proj, pitch, (s / steps) * pitch);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestPitch = pitch;
      }
    }
  }
  return bestPitch;
}

function estimateGridCount(raster: Raster, roi: Roi, gray: Gray): { columns: number; rows: number; confidence: number } {
  const fft = estimateGridFft(gray);
  let result: { columns: number; rows: number } | null = null;
  let usedFft = false;
  if (fft) {
    const pitchX = gray.width / fft.columns;
    const pitchY = gray.height / fft.rows;
    const ratio = Math.max(pitchX / pitchY, pitchY / pitchX);
    if (Math.min(pitchX, pitchY) >= 4 && Math.max(pitchX, pitchY) <= 30 && ratio <= 1.5) {
      result = fft;
      usedFft = true;
    }
  }
  const proj = gradientProjections(raster, roi);
  if (!result) {
    result = estimateGridGradient(proj.x, proj.y);
  }
  if (!result) {
    // 两条路都失败：按 20px 硬估一个，交给用户在校准步手改。
    return { columns: Math.max(1, Math.round(roi.width / 20)), rows: Math.max(1, Math.round(roi.height / 20)), confidence: 0 };
  }
  // comb 细化周期
  let pitchX = refinePitchByComb(proj.x, roi.width / result.columns);
  let pitchY = refinePitchByComb(proj.y, roi.height / result.rows);
  // 两向周期差异大时统一取较小者，否则取平均，保证方块。
  const ratio = Math.max(pitchX / pitchY, pitchY / pitchX);
  if (ratio > 1.5) {
    pitchX = pitchY = Math.min(pitchX, pitchY);
  } else {
    const avg = (pitchX + pitchY) / 2;
    pitchX = pitchY = avg;
  }
  return {
    columns: Math.max(1, Math.round(roi.width / pitchX)),
    rows: Math.max(1, Math.round(roi.height / pitchY)),
    confidence: usedFft ? 0.9 : 0.5,
  };
}

// 在 [origin-rmin, origin+rmax] 内找最强梯度局部峰；没有峰则保留理论位置。
function findBestGrid(origin: number, range: number, gradMag: Float64Array): number {
  let best = Math.round(origin);
  let bestValue = -1;
  const from = Math.max(1, Math.round(origin - range));
  const to = Math.min(gradMag.length - 2, Math.round(origin + range));
  for (let i = from; i <= to; i++) {
    if (gradMag[i] > gradMag[i - 1] && gradMag[i] > gradMag[i + 1] && gradMag[i] > bestValue) {
      bestValue = gradMag[i];
      best = i;
    }
  }
  return best;
}

// 从中心向两侧贪心生长网格线：每条线在理论位置 ±cell×refineIntensity 内吸附到
// 最近的真实边缘。线不要求等距——这是处理"块大小不均"的关键。
function refineGridLines(proj: Float64Array, size: number, count: number, refineIntensity = 0.25): number[] {
  const cell = size / count;
  const lines: number[] = [];
  const center = findBestGrid(size / 2, cell, proj);
  let x = center;
  while (x < size + cell / 2) {
    x = findBestGrid(x, cell * refineIntensity, proj);
    lines.push(x);
    x += cell;
  }
  x = center - cell;
  while (x > -cell / 2) {
    x = findBestGrid(x, cell * refineIntensity, proj);
    lines.push(x);
    x -= cell;
  }
  return lines.sort((a, b) => a - b);
}

// 逐格采样：格内去边 15%（避开吸附误差与抗锯齿边缘）后逐通道取中位数。
function sampleCells(raster: Raster, xLines: number[], yLines: number[], offsetX: number, offsetY: number): PixelCell[] {
  const cells: PixelCell[] = [];
  for (let row = 0; row < yLines.length - 1; row++) {
    for (let col = 0; col < xLines.length - 1; col++) {
      const x0 = xLines[col] + offsetX;
      const x1 = xLines[col + 1] + offsetX;
      const y0 = yLines[row] + offsetY;
      const y1 = yLines[row + 1] + offsetY;
      const mx = (x1 - x0) * 0.15;
      const my = (y1 - y0) * 0.15;
      const red: number[] = [];
      const green: number[] = [];
      const blue: number[] = [];
      const left = clamp(Math.ceil(x0 + mx), 0, raster.width - 1);
      const right = clamp(Math.floor(x1 - mx), 0, raster.width - 1);
      const top = clamp(Math.ceil(y0 + my), 0, raster.height - 1);
      const bottom = clamp(Math.floor(y1 - my), 0, raster.height - 1);
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const color = rgbAt(raster, x, y);
          red.push(color[0]);
          green.push(color[1]);
          blue.push(color[2]);
        }
      }
      cells.push({
        color: [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))],
        confidence: 1,
      });
    }
  }
  return cells;
}

// 背景置空：以四角格颜色为参照，从边界洪水填充所有与背景色 Lab 距离 < 18 的
// 连通格 → 置空。图案内部的白色块不与边界连通，得以保留。
function floodBackground(cells: PixelCell[], rows: number, columns: number): void {
  const corners = [0, columns - 1, (rows - 1) * columns, rows * columns - 1]
    .map((index) => cells[index]?.color)
    .filter((color): color is [number, number, number] => !!color);
  if (!corners.length) return;
  const background: [number, number, number] = [
    Math.round(median(corners.map((c) => c[0]))),
    Math.round(median(corners.map((c) => c[1]))),
    Math.round(median(corners.map((c) => c[2]))),
  ];
  const bgLab = rgbToLab(background);
  const THRESHOLD = 18;
  const visited = new Array<boolean>(rows * columns).fill(false);
  const queue: number[] = [];
  const tryEnqueue = (index: number) => {
    if (visited[index]) return;
    const color = cells[index].color;
    if (!color || distance(rgbToLab(color), bgLab) >= THRESHOLD) return;
    visited[index] = true;
    queue.push(index);
  };
  for (let col = 0; col < columns; col++) { tryEnqueue(col); tryEnqueue((rows - 1) * columns + col); }
  for (let row = 0; row < rows; row++) { tryEnqueue(row * columns); tryEnqueue(row * columns + columns - 1); }
  while (queue.length) {
    const index = queue.pop() as number;
    cells[index].color = null;
    const row = Math.floor(index / columns);
    const col = index % columns;
    if (row > 0) tryEnqueue(index - columns);
    if (row < rows - 1) tryEnqueue(index + columns);
    if (col > 0) tryEnqueue(index - 1);
    if (col < columns - 1) tryEnqueue(index + 1);
  }
}

function quantizeInPlace(cells: PixelCell[], maxColors: number): void {
  if (!maxColors || maxColors <= 0) return;
  const colored = cells.filter((cell) => cell.color).map((cell) => cell.color as [number, number, number]);
  if (!colored.length) return;
  const quantized = quantizeColors(colored, maxColors);
  let cursor = 0;
  cells.forEach((cell) => { if (cell.color) { cell.color = quantized[cursor]; cursor += 1; } });
}

/** 裁掉全空的边缘行列（ refine 的线允许越界半格，边缘格可能整个落在背景里）。 */
function trimEmpty(cells: PixelCell[], rows: number, columns: number): { cells: PixelCell[]; rows: number; columns: number; rowOffset: number; colOffset: number } {
  let rowMin = rows;
  let rowMax = -1;
  let colMin = columns;
  let colMax = -1;
  cells.forEach((cell, index) => {
    if (!cell.color) return;
    const row = Math.floor(index / columns);
    const col = index % columns;
    rowMin = Math.min(rowMin, row);
    rowMax = Math.max(rowMax, row);
    colMin = Math.min(colMin, col);
    colMax = Math.max(colMax, col);
  });
  if (rowMax < 0) return { cells, rows, columns, rowOffset: 0, colOffset: 0 };
  const next: PixelCell[] = [];
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) next.push(cells[row * columns + col]);
  }
  return { cells: next, rows: rowMax - rowMin + 1, columns: colMax - colMin + 1, rowOffset: rowMin, colOffset: colMin };
}

/**
 * 在均匀几何（校准步手调过的网格）上直接采样出矩阵。
 * 供像素模式的"确认网格并填充颜色"使用：用户的每一处手动修改都被尊重。
 */
export function samplePixelMatrix(raster: Raster, geometry: GridGeometry, rows: number, columns: number, maxColors = 16): PixelMatrix {
  const xLines = Array.from({ length: columns + 1 }, (_, i) => geometry.originX + i * geometry.cellWidth);
  const yLines = Array.from({ length: rows + 1 }, (_, i) => geometry.originY + i * geometry.cellHeight);
  const cells = sampleCells(raster, xLines, yLines, 0, 0);
  floodBackground(cells, rows, columns);
  const trimmed = trimEmpty(cells, rows, columns);
  quantizeInPlace(trimmed.cells, maxColors);
  return { rows: trimmed.rows, columns: trimmed.columns, background: [255, 255, 255], cells: trimmed.cells };
}

/**
 * 像素图自动检测：估计格子数 → 网格线吸附到真实边缘 → 采样 → 背景置空 → 量化。
 * geometry 是把不等距网格线折合成等间距几何（供叠加显示与手动微调）。
 */
export function detectPixelArt(raster: Raster, roi: Roi, maxColors = 16): PixelArtDetection {
  const region = normalizeRoi(raster, roi);
  const gray = toGray(raster, region);
  const estimate = estimateGridCount(raster, region, gray);
  const proj = gradientProjections(raster, region);
  const xLines = refineGridLines(proj.x, region.width, estimate.columns);
  const yLines = refineGridLines(proj.y, region.height, estimate.rows);
  const cells = sampleCells(raster, xLines, yLines, region.x, region.y);
  const rows = yLines.length - 1;
  const columns = xLines.length - 1;
  floodBackground(cells, rows, columns);
  const trimmed = trimEmpty(cells, rows, columns);
  quantizeInPlace(trimmed.cells, maxColors);
  // 等效均匀几何：原点取首条线（加裁剪偏移），格宽取平均线距。
  const cellWidth = columns > 1 ? (xLines[xLines.length - 1] - xLines[0]) / (xLines.length - 1) : region.width;
  const cellHeight = rows > 1 ? (yLines[yLines.length - 1] - yLines[0]) / (yLines.length - 1) : region.height;
  return {
    matrix: { rows: trimmed.rows, columns: trimmed.columns, background: [255, 255, 255], cells: trimmed.cells },
    rows: trimmed.rows,
    columns: trimmed.columns,
    geometry: {
      originX: region.x + xLines[0] + trimmed.colOffset * cellWidth,
      originY: region.y + yLines[0] + trimmed.rowOffset * cellHeight,
      cellWidth,
      cellHeight,
    },
    confidence: estimate.confidence,
  };
}
