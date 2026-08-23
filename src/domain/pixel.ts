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

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1)];
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

// 沿某个轴对 ROI 做“梯度能量投影”：Sobel 式亮度差分 + 0.8 分位数。
// 不用暗度中位数：格线、编号文字、色块边缘、虚线都是同周期的合法证据，
// 应该全部保留（网格越淡，编号文字越有价值）。0.8 分位数在“只留贯穿全图的
// 格线”（中位数）和“被大块色块淹没”（平均值）之间取折中。
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
      // x 轴信号关心竖向结构（水平方向亮度差），y 轴反之。
      const gradient = axis === "x"
        ? Math.abs(luminance(raster, x + 1, y) - luminance(raster, x - 1, y))
        : Math.abs(luminance(raster, x, y + 1) - luminance(raster, x, y - 1));
      samples.push(gradient);
    }
    values[position] = quantile(samples, 0.8);
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

// 自相关 + 谐波峰列拟合。不判断“哪个峰是基频”，而是找一个 p 让最多的峰
// 落在 n×p 上，再用全部峰做最小二乘 p = Σn·d / Σn²。
// 亚像素精度来自多个倍频共同回归，不再需要 ±1.5px / 0.05 步长的暴力细化。
// 候选 p 必须满足“1p 处本身有峰”，因此不会锁到 p/2；而 2p 候选会丢掉
// 一半峰（p、3p… 不再是整数倍），证据多的 p 自然胜出。
function findPitch(values: readonly number[]): { pitch: number; score: number } {
  const residual = detrend(values);
  const maxLag = Math.min(64, Math.floor(values.length / 4));
  if (maxLag < 8) return { pitch: Math.max(4, maxLag) || 18, score: 0 };
  const curve: number[] = [];
  for (let lag = 8; lag <= maxLag; lag += 1) curve.push(correlation(residual, lag));
  // 局部峰，三点抛物线插值出亚像素峰位。
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let i = 1; i < curve.length - 1; i += 1) {
    if (curve[i] <= 0 || curve[i] <= curve[i - 1] || curve[i] < curve[i + 1]) continue;
    const denominator = curve[i - 1] - 2 * curve[i] + curve[i + 1];
    const delta = denominator ? clamp(0.5 * (curve[i - 1] - curve[i + 1]) / denominator, -0.5, 0.5) : 0;
    peaks.push({ lag: i + 8 + delta, score: curve[i] });
  }
  if (!peaks.length) return { pitch: 18, score: 0 };
  // 格线↔文字的交叉项会在 p/2 处产生弱峰（幅值通常不到真实谐波的 1/10），
  // 不过滤的话候选 p/2 会靠“峰多”在求和权重上险胜真正的 p。
  const strongest = Math.max(...peaks.map((peak) => peak.score));
  const significant = peaks.filter((peak) => peak.score >= strongest * 0.25);
  let best: { pitch: number; score: number; inliers: Array<{ n: number; lag: number; score: number }> } | null = null;
  for (let p = 8; p <= maxLag; p += 0.1) {
    const tolerance = Math.max(0.8, p * 0.06);
    let hasBase = false;
    let weight = 0;
    const inliers: Array<{ n: number; lag: number; score: number }> = [];
    for (const peak of significant) {
      const n = Math.round(peak.lag / p);
      if (n < 1 || Math.abs(peak.lag - n * p) > tolerance) continue;
      // 1p 基频峰必须足够强：格内若存在每格重复 3 次的结构（如多笔画编号），
      // 会产生 p/3 间隔的密集峰列，否则候选 2p/3 会靠“峰多”累计权重险胜真周期。
      if (n === 1) {
        if (peak.score < strongest * 0.4) continue;
        hasBase = true;
      }
      weight += peak.score;
      inliers.push({ n, lag: peak.lag, score: peak.score });
    }
    if (!hasBase) continue;
    if (!best || weight > best.score) best = { pitch: p, score: weight, inliers };
  }
  if (!best) return { pitch: significant[0].lag, score: 0 };
  // 最小二乘细化：d_n ≈ n·p → p = Σ(n·d) / Σ(n²)
  let sumND = 0;
  let sumNN = 0;
  for (const inlier of best.inliers) {
    sumND += inlier.n * inlier.lag;
    sumNN += inlier.n * inlier.n;
  }
  const pitch = sumNN ? sumND / sumNN : best.pitch;
  const confidence = clamp(best.score / best.inliers.length, 0, 1);
  return { pitch, score: confidence };
}

// comb 搜索：相位只需在 [0, pitch) 内找，让梳齿尽量压在梯度能量高的位置
// （格线/色块边界）。格心不再做惩罚项——编号文字本身就在格心产生梯度，
// 惩罚它会抵消文字这条证据。格线 vs 格心的 p/2 歧义交给格内一致性裁决。
function findPhase(proj: readonly number[], pitch: number): number {
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = 0; offset < pitch; offset += 0.25) {
    let border = 0;
    let borderCount = 0;
    for (let k = 0; ; k += 1) {
      const line = offset + k * pitch;
      if (line >= proj.length) break;
      border += interp(proj, line);
      borderCount += 1;
    }
    const score = border / Math.max(1, borderCount);
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  return bestOffset;
}

// 格内一致性：正确相位下每个格子的四角区域（避开格线与中心编号）应接近单色。
// 相位错半格时四角会横跨两个豆子，方差明显变大。返回归一化后的平均方差。
function cellUniformity(raster: Raster, geometry: GridGeometry, rows: number, columns: number): number {
  const stride = Math.max(1, Math.ceil((rows * columns) / 400));
  let total = 0;
  let counted = 0;
  for (let index = 0; index < rows * columns; index += stride) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = geometry.originX + column * geometry.cellWidth;
    const top = geometry.originY + row * geometry.cellHeight;
    const width = geometry.cellWidth;
    const height = geometry.cellHeight;
    const colors: Array<[number, number, number]> = [];
    const collect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = clamp(Math.ceil(y0), 0, raster.height - 1); y <= clamp(Math.floor(y1), 0, raster.height - 1); y += 1) {
        for (let x = clamp(Math.ceil(x0), 0, raster.width - 1); x <= clamp(Math.floor(x1), 0, raster.width - 1); x += 1) {
          colors.push(rgbAt(raster, x, y));
        }
      }
    };
    collect(left + width * 0.14, top + height * 0.14, left + width * 0.34, top + height * 0.34);
    collect(left + width * 0.66, top + height * 0.14, left + width * 0.86, top + height * 0.34);
    collect(left + width * 0.14, top + height * 0.66, left + width * 0.34, top + height * 0.86);
    collect(left + width * 0.66, top + height * 0.66, left + width * 0.86, top + height * 0.86);
    if (colors.length < 4) continue;
    const mean = [0, 0, 0];
    for (const color of colors) { mean[0] += color[0]; mean[1] += color[1]; mean[2] += color[2]; }
    mean[0] /= colors.length; mean[1] /= colors.length; mean[2] /= colors.length;
    let variance = 0;
    for (const color of colors) variance += (color[0] - mean[0]) ** 2 + (color[1] - mean[1]) ** 2 + (color[2] - mean[2]) ** 2;
    total += variance / colors.length;
    counted += 1;
  }
  return counted ? total / counted : Infinity;
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

// 完整自动流程：ROI 内梯度投影 → 谐波拟合亚像素周期 → X/Y 联合校正倍频
// → comb 搜索相位 → 格内一致性裁决 p/2 歧义 → inkRatio + Otsu → 裁剪到有效格外接框。
export function detectGrid(raster: Raster, roi?: Roi | null): GridDetection {
  const region = normalizeRoi(raster, roi);
  const projectionX = projection(raster, region, "x");
  const projectionY = projection(raster, region, "y");
  const pitchX = findPitch(projectionX);
  const pitchY = findPitch(projectionY);
  // 拼豆格近似正方形：两边周期相差整数倍时，几乎必有一边锁到了倍频，
  // 把大的一边除回来（谐波拟合要求 1p 处有峰，小的一边更可信）。
  const ratio = pitchX.pitch / pitchY.pitch;
  const multiple = Math.round(ratio);
  if (multiple >= 2 && Math.abs(ratio - multiple) < 0.12) {
    if (pitchX.pitch > pitchY.pitch) pitchX.pitch /= multiple;
    else pitchY.pitch /= multiple;
  }
  let originX = region.x + findPhase(projectionX, pitchX.pitch);
  let originY = region.y + findPhase(projectionY, pitchY.pitch);
  // 行列数按“格心落在 ROI 内”计数：comb 锁到的相位可能偏到格线边缘
  // （梯度投影里一条格线有两个边缘峰），用 round((size-origin)/pitch) 会在
  // ROI 边缘丢掉一整行/列。先按格心归属算出首格索引，再反推原点。
  const lattice = (offset: number, size: number, pitch: number) => {
    const kMin = Math.ceil((0 - offset) / pitch - 0.5);
    const kMax = Math.floor((size - offset) / pitch - 0.5);
    return { start: offset + kMin * pitch, count: Math.max(1, kMax - kMin + 1) };
  };
  const latticeX = lattice(originX - region.x, region.width, pitchX.pitch);
  const latticeY = lattice(originY - region.y, region.height, pitchY.pitch);
  originX = region.x + latticeX.start;
  originY = region.y + latticeY.start;
  const columns = latticeX.count;
  const rows = latticeY.count;
  // 编号文字中心同样是 p 周期，comb 可能锁到格心。比较 φ 与 φ+p/2 两种
  // 切法的格内四角颜色方差，更均匀的才是真实格线。
  const candidate: GridGeometry = { originX, originY, cellWidth: pitchX.pitch, cellHeight: pitchY.pitch };
  const shifted: GridGeometry = { ...candidate, originX: originX + pitchX.pitch / 2, originY: originY + pitchY.pitch / 2 };
  if (cellUniformity(raster, shifted, rows, columns) < cellUniformity(raster, candidate, rows, columns)) {
    originX = shifted.originX;
    originY = shifted.originY;
  }
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
