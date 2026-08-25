import { useEffect, useMemo, useState } from "react";
import {
  analyzeOccupancy,
  applyThreshold,
  colorKey,
  detectGrid,
  fullRoi,
  recognizeMatrix,
  renderMatrix,
  floatingBlockOffsets,
  type GridGeometry,
  type PixelCell,
  type PixelMatrix,
  type Raster,
  type Roi,
} from "../domain/pixel";
import { hex, imageToRaster, parseHex } from "./helpers";
import { CalibrateStep } from "./steps/CalibrateStep";
import { CropStep } from "./steps/CropStep";
import { EditStep } from "./steps/EditStep";
import { UploadStep } from "./steps/UploadStep";
import { STEP_LABELS, STEP_ORDER, titleFor, type GridState, type Step, type Tool } from "./types";

export function App() {
  const [step, setStep] = useState<Step>("upload");
  const [raster, setRaster] = useState<Raster | null>(null);
  const [fileName, setFileName] = useState("拼豆图纸");
  const [roi, setRoi] = useState<Roi | null>(null);
  const [grid, setGrid] = useState<GridState | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [flips, setFlips] = useState<Record<number, boolean>>({});
  const [alignMode, setAlignMode] = useState(false);
  const [showScores, setShowScores] = useState(false);
  const [selectedCell, setSelectedCell] = useState(0);
  const [matrix, setMatrix] = useState<PixelMatrix | null>(null);
  const [history, setHistory] = useState<PixelCell[][]>([]);
  const [future, setFuture] = useState<PixelCell[][]>([]);
  const [tool, setTool] = useState<Tool>("paint");
  const [paintColor, setPaintColor] = useState("#164e63");
  const [showGrid, setShowGrid] = useState(true);
  const [exportScale, setExportScale] = useState(10);
  const [maxColors, setMaxColors] = useState(16);
  const [overlapPx, setOverlapPx] = useState(2);
  const [error, setError] = useState("");

  // 网格几何一旦变化就重新计算每格 inkRatio；几何变化同时清空人工修正。
  const analysis = useMemo(
    () => (raster && grid ? analyzeOccupancy(raster, grid.geometry, grid.rows, grid.columns) : null),
    [raster, grid],
  );

  useEffect(() => {
    setThreshold(null);
    setFlips({});
    setSelectedCell(0);
  }, [analysis]);

  const effectiveThreshold = threshold ?? analysis?.threshold ?? 0;
  const maxScore = useMemo(() => (analysis ? Math.max(0.02, ...analysis.scores) : 0.02), [analysis]);

  const occupancy = useMemo(() => {
    if (!analysis) return [];
    const automatic = applyThreshold(analysis.scores, effectiveThreshold);
    return automatic.map((occupied, index) => flips[index] ?? occupied);
  }, [analysis, effectiveThreshold, flips]);

  const palette = useMemo(() => {
    if (!matrix) return [];
    const seen = new Map<string, [number, number, number]>();
    matrix.cells.forEach((cell) => { if (cell.color) seen.set(colorKey(cell.color), cell.color); });
    return [...seen.values()];
  }, [matrix]);

  const occupancyPreview = useMemo<PixelMatrix | null>(() => {
    if (!grid || !analysis) return null;
    // 分数落在阈值 ±30% 的格子标记为“不确定”，用橙色提示人工检查；
    // 人工点击过的格子视为已确认，直接显示切换后的状态色。
    const band = Math.max(0.004, effectiveThreshold * 0.3);
    return {
      rows: grid.rows,
      columns: grid.columns,
      background: [255, 255, 255],
      cells: analysis.scores.map((score, index) => {
        const occupied = occupancy[index];
        const manual = Object.prototype.hasOwnProperty.call(flips, index);
        const uncertain = !manual && Math.abs(score - effectiveThreshold) <= band;
        return {
          color: uncertain ? [217, 119, 6] as [number, number, number] : occupied ? [20, 93, 89] as [number, number, number] : null,
          confidence: score,
        };
      }),
    };
  }, [grid, analysis, occupancy, effectiveThreshold, flips]);

  async function loadFile(file: File) {
    setError("");
    if (!file.type.startsWith("image/")) { setError("请选择 PNG、JPG 或 WebP 图片。"); return; }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const nextRaster = imageToRaster(image);
      setRaster(nextRaster);
      setRoi(fullRoi(nextRaster));
      setGrid(null);
      setMatrix(null);
      setFileName(file.name.replace(/\.[^.]+$/, "") || "拼豆图纸");
      setStep("crop");
    } catch {
      setError("图片读取失败，请换一张清晰的规则网格图纸。");
    } finally { URL.revokeObjectURL(url); }
  }

  function runDetection(region: Roi) {
    if (!raster) return;
    const detection = detectGrid(raster, region);
    setGrid({ roi: detection.roi, rows: detection.rows, columns: detection.columns, geometry: detection.geometry, confidence: detection.confidence });
    setAlignMode(false);
    setStep("calibrate");
  }

  /** 几何变化后，行列数始终按 ROI 重新推导，保证网格不漂出框选区域。 */
  function updateGeometry(patch: Partial<GridGeometry>) {
    if (!grid) return;
    const geometry = { ...grid.geometry, ...patch };
    const columns = Math.max(1, Math.round((grid.roi.x + grid.roi.width - geometry.originX) / geometry.cellWidth));
    const rows = Math.max(1, Math.round((grid.roi.y + grid.roi.height - geometry.originY) / geometry.cellHeight));
    setGrid({ ...grid, geometry, rows, columns });
  }

  function updateDimensions(key: "rows" | "columns", value: number) {
    if (!grid || !Number.isFinite(value)) return;
    const safe = Math.max(1, Math.min(256, Math.round(value)));
    const geometry = { ...grid.geometry };
    if (key === "columns") geometry.cellWidth = (grid.roi.x + grid.roi.width - geometry.originX) / safe;
    else geometry.cellHeight = (grid.roi.y + grid.roi.height - geometry.originY) / safe;
    setGrid({ ...grid, geometry, rows: key === "rows" ? safe : grid.rows, columns: key === "columns" ? safe : grid.columns });
  }

  /** 点击一个真实格线交点：相位对齐到点击处，整个无限 lattice 随之确定。 */
  function alignAt(x: number, y: number) {
    if (!grid) return;
    const { geometry, roi } = grid;
    const originX = x - Math.round((x - roi.x) / geometry.cellWidth) * geometry.cellWidth;
    const originY = y - Math.round((y - roi.y) / geometry.cellHeight) * geometry.cellHeight;
    const columns = Math.max(1, Math.round((roi.x + roi.width - originX) / geometry.cellWidth));
    const rows = Math.max(1, Math.round((roi.y + roi.height - originY) / geometry.cellHeight));
    setGrid({ ...grid, geometry: { ...geometry, originX, originY }, rows, columns });
  }

  function toggleOccupancy(index: number) {
    setSelectedCell(index);
    setFlips((previous) => ({ ...previous, [index]: !occupancy[index] }));
  }

  function recognize() {
    if (!raster || !grid) return;
    const nextMatrix = recognizeMatrix(raster, { rows: grid.rows, columns: grid.columns, geometry: grid.geometry, occupancy }, 0, maxColors);
    setMatrix(nextMatrix);
    setHistory([]);
    setFuture([]);
    setStep("edit");
  }

  function reset() {
    setStep("upload");
    setRaster(null);
    setRoi(null);
    setGrid(null);
    setMatrix(null);
    setError("");
  }

  function changeCell(index: number, color: [number, number, number] | null) {
    if (!matrix) return;
    setHistory((items) => [...items.slice(-29), matrix.cells]);
    setFuture([]);
    setMatrix({ ...matrix, cells: matrix.cells.map((cell, cellIndex) => cellIndex === index ? { ...cell, color } : cell) });
  }

  function editCell(index: number) {
    if (!matrix) return;
    if (tool === "erase") changeCell(index, null);
    else if (tool === "pick") {
      const color = matrix.cells[index].color;
      if (color) { setPaintColor(hex(color)); setTool("paint"); }
    } else changeCell(index, parseHex(paintColor));
  }

  function undo() {
    if (!matrix || !history.length) return;
    const previous = history[history.length - 1];
    setFuture((items) => [...items, matrix.cells]);
    setHistory((items) => items.slice(0, -1));
    setMatrix({ ...matrix, cells: previous });
  }

  function redo() {
    if (!matrix || !future.length) return;
    const next = future[future.length - 1];
    setHistory((items) => [...items, matrix.cells]);
    setFuture((items) => items.slice(0, -1));
    setMatrix({ ...matrix, cells: next });
  }

  function exportPng() {
    if (!matrix) return;
    const scale = Math.max(1, Math.min(50, Math.round(exportScale) || 1));
    const fix = floatingBlockOffsets(matrix);
    const canvas = document.createElement("canvas");
    // 逐格按 scale×scale 实心矩形绘制；仅靠角相连的悬空块朝主体偏移 overlapPx，与主体产生小重叠。
    const image = renderMatrix(matrix, { scale, offsetPx: overlapPx, offsets: fix.offsets });
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileName}-像素图.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  }

  const confidence = grid ? Math.round(grid.confidence * 100) : 0;
  const occupiedCount = occupancy.filter(Boolean).length;
  const safeExportScale = Math.max(1, Math.min(50, Math.round(exportScale) || 1));
  const safeOverlap = Math.max(0, Math.min(safeExportScale, Math.round(overlapPx) || 0));
  const cornerFix = useMemo(() => (matrix ? floatingBlockOffsets(matrix) : null), [matrix]);
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">豆</div>
        <div><p className="eyebrow">BEAD PATTERN TOOL</p><h1>拼豆图纸转像素图</h1></div>
        <div className="topbar-actions">
          <label className="button secondary">打开图片<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file); }} /></label>
          {raster && <button className="button secondary" type="button" onClick={reset}>重新开始</button>}
        </div>
      </header>

      <section className="intro">
        <div><p className="eyebrow">LOCAL · PRIVATE · PNG</p><h2>{titleFor(step)}</h2><p>框选带编号的拼豆图纸，校准网格后确认识别结果，导出适合 3D 打印的透明像素 PNG。</p></div>
        <div className="steps">{STEP_LABELS.map((label, index) => <span key={label} className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}>{label}</span>)}</div>
      </section>

      {error && <div className="notice error">{error}</div>}

      {step === "upload" && <UploadStep onFile={(file) => void loadFile(file)} />}

      {step === "crop" && raster && (
        <CropStep
          raster={raster}
          roi={roi}
          onRoiChange={setRoi}
          onUseFullImage={() => setRoi(fullRoi(raster))}
          onConfirm={() => { if (roi) runDetection(roi); }}
        />
      )}

      {step === "calibrate" && raster && grid && analysis && occupancyPreview && (
        <CalibrateStep
          raster={raster}
          grid={grid}
          analysis={analysis}
          occupancyPreview={occupancyPreview}
          confidence={confidence}
          occupiedCount={occupiedCount}
          showScores={showScores}
          onShowScoresChange={setShowScores}
          onToggleOccupancy={toggleOccupancy}
          selectedCell={selectedCell}
          onSelectCell={setSelectedCell}
          alignMode={alignMode}
          onToggleAlignMode={() => setAlignMode((value) => !value)}
          onAlign={alignAt}
          effectiveThreshold={effectiveThreshold}
          onThresholdChange={setThreshold}
          maxScore={maxScore}
          maxColors={maxColors}
          onMaxColorsChange={setMaxColors}
          onUpdateDimensions={updateDimensions}
          onUpdateGeometry={updateGeometry}
          onRedetect={() => runDetection(grid.roi)}
          onBackToCrop={() => setStep("crop")}
          onRecognize={recognize}
        />
      )}

      {step === "edit" && matrix && (
        <EditStep
          matrix={matrix}
          showGrid={showGrid}
          onShowGridChange={setShowGrid}
          onEditCell={editCell}
          palette={palette}
          tool={tool}
          onToolChange={setTool}
          paintColor={paintColor}
          onPaintColorChange={setPaintColor}
          canUndo={history.length > 0}
          canRedo={future.length > 0}
          onUndo={undo}
          onRedo={redo}
          exportScale={exportScale}
          onExportScaleChange={setExportScale}
          overlapPx={overlapPx}
          onOverlapPxChange={setOverlapPx}
          safeExportScale={safeExportScale}
          safeOverlap={safeOverlap}
          cornerFix={cornerFix}
          onExport={exportPng}
          onBackToCalibrate={() => setStep("calibrate")}
        />
      )}

      <footer>图像处理完全在浏览器本地完成 · 不上传原图</footer>
    </main>
  );
}
