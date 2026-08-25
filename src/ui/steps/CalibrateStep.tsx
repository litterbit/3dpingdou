import type { GridGeometry, OccupancyAnalysis, PixelMatrix, Raster } from "../../domain/types";
import type { ImageKind } from "../../domain/classify";
import { Field } from "../Field";
import { GridCanvas } from "../GridCanvas";
import { PixelPreview } from "../PixelPreview";
import type { GridState } from "../types";

export function CalibrateStep({ raster, grid, kind, analysis, occupancyPreview, pixelPreview, confidence, occupiedCount, showScores, onShowScoresChange, onToggleOccupancy, selectedCell, onSelectCell, alignMode, onToggleAlignMode, onAlign, effectiveThreshold, onThresholdChange, maxScore, maxColors, onMaxColorsChange, onUpdateDimensions, onUpdateGeometry, onRedetect, onBackToCrop, onRecognize }: {
  raster: Raster;
  grid: GridState;
  kind: ImageKind;
  /** 图纸模式的占位分析；像素图模式为 null */
  analysis: OccupancyAnalysis | null;
  /** 图纸模式的占位预览；像素图模式为 null */
  occupancyPreview: PixelMatrix | null;
  /** 像素图模式的采样预览；图纸模式为 null */
  pixelPreview: PixelMatrix | null;
  confidence: number;
  occupiedCount: number;
  showScores: boolean;
  onShowScoresChange: (value: boolean) => void;
  onToggleOccupancy: (index: number) => void;
  selectedCell: number;
  onSelectCell: (index: number) => void;
  alignMode: boolean;
  onToggleAlignMode: () => void;
  onAlign: (x: number, y: number) => void;
  effectiveThreshold: number;
  onThresholdChange: (value: number) => void;
  maxScore: number;
  maxColors: number;
  onMaxColorsChange: (value: number) => void;
  onUpdateDimensions: (key: "rows" | "columns", value: number) => void;
  onUpdateGeometry: (patch: Partial<GridGeometry>) => void;
  onRedetect: () => void;
  onBackToCrop: () => void;
  onRecognize: () => void;
}) {
  const isPixel = kind === "pixel";
  return (
    <section className="workspace calibrate-layout">
      <div className="panel image-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">{isPixel ? "PIXEL GRID" : "OCCUPANCY"}</p><h3>确认识别结果</h3></div>
          <span className="metric">网格置信度 {confidence}%</span>
        </div>
        {isPixel ? (
          <p className="hint-strong">像素图按网格直接取色，与背景连通的浅色区域自动留空。<strong>行列数不对时在右侧直接修改</strong>，预览会实时更新；确认网格线对齐后点“确认网格并填充颜色”。</p>
        ) : (
          <p className="hint-strong">绿色是有豆格，棋盘格是空位，橙色是分数接近阈值的“不确定”格。<strong>点击矩阵中的任意格子可逐格切换有豆/空位</strong>（橙色格点一下即可确认或排除）；打开“显示分数”可查看每格墨迹比例。</p>
        )}
        <div className="binary-stage">
          {isPixel
            ? (pixelPreview && <PixelPreview matrix={pixelPreview} />)
            : (occupancyPreview && <PixelPreview matrix={occupancyPreview} onCellClick={onToggleOccupancy} labels={showScores ? analysis?.scores.map((score) => score.toFixed(2)) : undefined} />)}
        </div>
        <div className="matrix-caption">
          <span>有效格 {occupiedCount} 格</span>
          {!isPixel && (
            <label className="toggle"><input type="checkbox" checked={showScores} onChange={(event) => onShowScoresChange(event.target.checked)} /><span>显示分数</span></label>
          )}
          <span className="caption-spacer" />
          <span>{grid.columns} × {grid.rows}</span>
        </div>
        <div className="canvas-wrap source-reference"><GridCanvas raster={raster} grid={grid} selectedCell={selectedCell} alignMode={alignMode} onCellClick={onSelectCell} onAlign={onAlign} /></div>
        <p className="muted">{isPixel ? "核对下方网格线是否精确压在像素块边界上。" : "核对下方网格线是否精确压在原图格线上。没对齐时点“点击对齐交点”，再点一个真实格线交叉点即可。"}</p>
      </div>
      <div className="panel controls-panel">
        <div className="panel-heading"><div><p className="eyebrow">GRID</p><h3>{isPixel ? "网格" : "网格与阈值"}</h3></div></div>
        <p className="muted">自动检测周期约 {grid.geometry.cellWidth.toFixed(2)} × {grid.geometry.cellHeight.toFixed(2)} px。行列数改变时会按{isPixel ? "图案范围" : "框选区域"}重新均分。</p>
        <div className="form-grid">
          <Field label="列数" value={grid.columns} min={1} max={256} onChange={(value) => onUpdateDimensions("columns", value)} />
          <Field label="行数" value={grid.rows} min={1} max={256} onChange={(value) => onUpdateDimensions("rows", value)} />
          <Field label="起点 X" value={grid.geometry.originX} step={0.5} onChange={(value) => onUpdateGeometry({ originX: value })} />
          <Field label="起点 Y" value={grid.geometry.originY} step={0.5} onChange={(value) => onUpdateGeometry({ originY: value })} />
          <Field label="格宽" value={grid.geometry.cellWidth} min={2} step={0.1} onChange={(value) => onUpdateGeometry({ cellWidth: value })} />
          <Field label="格高" value={grid.geometry.cellHeight} min={2} step={0.1} onChange={(value) => onUpdateGeometry({ cellHeight: value })} />
        </div>
        <div className="form-grid">
          <Field label="颜色上限" value={maxColors} min={1} max={64} onChange={(value) => onMaxColorsChange(Math.max(1, Math.min(64, Math.round(value) || 1)))} />
        </div>
        <p className="muted">拼豆色号通常很少：填充颜色时，相近的采样色会自动合并，最终颜色不会超过这个数量。</p>
        {!isPixel && (
          <label className="field threshold-field">
            <span>占位阈值（墨迹比例 &gt; {effectiveThreshold.toFixed(3)} 判为有豆，自动值由 Otsu 给出）</span>
            <input type="range" min={0} max={maxScore} step={maxScore / 200} value={effectiveThreshold} onChange={(event) => onThresholdChange(Number(event.target.value))} />
          </label>
        )}
        <div className="action-column">
          {!isPixel && (
            <button type="button" className={`button ${alignMode ? "primary" : "secondary"}`} onClick={onToggleAlignMode}>{alignMode ? "对齐模式已开启：点击一个格线交点" : "点击对齐交点"}</button>
          )}
          <button type="button" className="button secondary" onClick={onRedetect}>重新自动检测</button>
          <button type="button" className="button secondary" onClick={onBackToCrop}>返回重新框选</button>
          <button type="button" className="button primary" onClick={onRecognize}>{isPixel ? "确认网格并填充颜色" : "确认占位并填充颜色"}</button>
        </div>
      </div>
    </section>
  );
}
