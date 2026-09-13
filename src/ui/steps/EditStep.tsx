import { useState } from "react";
import type { FloatingBlockOffsets, PixelMatrix } from "../../domain/pixel";
import { colorKey } from "../../domain/pixel";
import { Field } from "../Field";
import { PixelPreview } from "../PixelPreview";
import { hex } from "../helpers";
import type { Tool } from "../types";

export function EditStep({ matrix, showGrid, onShowGridChange, onEditCell, palette, tool, onToolChange, paintColor, onPaintColorChange, onReplaceColor, canUndo, canRedo, onUndo, onRedo, exportScale, onExportScaleChange, overlapPx, onOverlapPxChange, safeExportScale, safeOverlap, cornerFix, onExport, onBackToCalibrate }: {
  matrix: PixelMatrix;
  showGrid: boolean;
  onShowGridChange: (value: boolean) => void;
  onEditCell: (index: number) => void;
  palette: [number, number, number][];
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  paintColor: string;
  onPaintColorChange: (color: string) => void;
  onReplaceColor: (from: [number, number, number], toHex: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  exportScale: number;
  onExportScaleChange: (value: number) => void;
  overlapPx: number;
  onOverlapPxChange: (value: number) => void;
  safeExportScale: number;
  safeOverlap: number;
  cornerFix: FloatingBlockOffsets | null;
  onExport: () => void;
  onBackToCalibrate: () => void;
}) {
  // 换色模式：点调色板选中要替换的颜色，再用取色器选新颜色，点“应用换色”一次性替换全图。
  const [replaceMode, setReplaceMode] = useState(false);
  const [replaceFrom, setReplaceFrom] = useState<[number, number, number] | null>(null);
  const [replaceTo, setReplaceTo] = useState("#ffffff");

  function toggleReplaceMode() {
    setReplaceMode((value) => !value);
    setReplaceFrom(null);
  }

  function pickSwatch(color: [number, number, number]) {
    if (replaceMode) {
      setReplaceFrom(color);
      setReplaceTo(hex(color));
    } else {
      onPaintColorChange(hex(color));
      onToolChange("paint");
    }
  }

  return (
    <section className="workspace editor-layout">
      <div className="panel matrix-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PIXEL MATRIX</p><h3>{matrix.columns} × {matrix.rows} 逻辑像素</h3></div>
          <label className="toggle"><input type="checkbox" checked={showGrid} onChange={(event) => onShowGridChange(event.target.checked)} /><span>网格</span></label>
        </div>
        <div className="matrix-stage"><PixelPreview matrix={matrix} showGrid={showGrid} onCellClick={onEditCell} /></div>
        <div className="matrix-caption">
          <span>透明区域</span><span className="checker-chip" />
          <span>{matrix.cells.filter((cell) => !cell.color).length} 格</span>
          <span className="caption-spacer" />
          <button type="button" className="text-button" onClick={onBackToCalibrate}>返回校准</button>
          <span>{palette.length} 种颜色</span>
        </div>
      </div>
      <aside className="panel tool-panel">
        <div className="panel-heading"><div><p className="eyebrow">TOOLS</p><h3>编辑图案</h3></div></div>
        <div className="tool-buttons">
          <button type="button" className={tool === "paint" ? "tool active" : "tool"} onClick={() => onToolChange("paint")}>画笔</button>
          <button type="button" className={tool === "erase" ? "tool active" : "tool"} onClick={() => onToolChange("erase")}>橡皮</button>
          <button type="button" className={tool === "pick" ? "tool active" : "tool"} onClick={() => onToolChange("pick")}>吸管</button>
        </div>
        <label className="color-picker"><span>当前颜色</span><input type="color" value={paintColor} onChange={(event) => onPaintColorChange(event.target.value)} /><code>{paintColor.toUpperCase()}</code></label>
        <div className="palette">
          <div className="palette-head">
            <span className="label">图案颜色</span>
            <button type="button" className={replaceMode ? "text-button active" : "text-button"} onClick={toggleReplaceMode}>{replaceMode ? "完成换色" : "换色"}</button>
          </div>
          {palette.map((color) => (
            <button
              type="button"
              key={colorKey(color)}
              className={replaceMode && replaceFrom && colorKey(replaceFrom) === colorKey(color) ? "swatch selected" : "swatch"}
              style={{ backgroundColor: hex(color) }}
              aria-label={replaceMode ? `替换颜色 ${hex(color)}` : `选择颜色 ${hex(color)}`}
              onClick={() => pickSwatch(color)}
            />
          ))}
        </div>
        {replaceMode && (
          replaceFrom ? (
            <div className="recolor-bar">
              <span className="swatch" style={{ backgroundColor: hex(replaceFrom) }} />
              <span className="muted">→</span>
              <input type="color" value={replaceTo} onChange={(event) => setReplaceTo(event.target.value)} />
              <code>{replaceTo.toUpperCase()}</code>
              <button type="button" className="button secondary" onClick={() => { onReplaceColor(replaceFrom, replaceTo); setReplaceFrom(null); }}>应用换色</button>
            </div>
          ) : (
            <p className="muted">点击上方一个颜色，把它整体换成新颜色。</p>
          )
        )}
        <div className="history-buttons">
          <button type="button" className="button secondary" disabled={!canUndo} onClick={onUndo}>撤销</button>
          <button type="button" className="button secondary" disabled={!canRedo} onClick={onRedo}>重做</button>
        </div>
        <div className="export-size">
          <Field label="每格像素" value={exportScale} min={1} max={50} onChange={(value) => onExportScaleChange(Math.max(1, Math.min(50, Math.round(value) || 1)))} />
          <Field label="悬空块偏移（像素）" value={overlapPx} min={0} max={safeExportScale} onChange={(value) => onOverlapPxChange(Math.max(0, Math.min(safeExportScale, Math.round(value) || 0)))} />
          <span className="muted">导出尺寸 {matrix.columns * safeExportScale + safeOverlap * 2} × {matrix.rows * safeExportScale + safeOverlap * 2} px</span>
          {cornerFix && cornerFix.fixed > 0 && <span className="muted">{cornerFix.fixed} 个仅靠角相连的色块，导出时会朝主体偏移 {safeOverlap} px 产生重叠，打印后即粘在主体上。</span>}
          {cornerFix && cornerFix.stranded > 0 && <span className="muted">{cornerFix.stranded} 个色块与主体完全分离（连角都不挨着），无法自动粘连，请先用画笔补连。</span>}
        </div>
        <button type="button" className="button primary full" onClick={onExport}>下载透明 PNG</button>
      </aside>
    </section>
  );
}
