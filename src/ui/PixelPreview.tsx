import type { CSSProperties } from "react";
import type { PixelMatrix } from "../domain/types";
import { hex } from "./helpers";

export function PixelPreview({ matrix, onCellClick, showGrid = true, labels }: { matrix: PixelMatrix; onCellClick?: (index: number) => void; showGrid?: boolean; labels?: string[] }) {
  return (
    <div className={`pixel-preview ${showGrid ? "show-grid" : ""}`} style={{ "--columns": matrix.columns, "--rows": matrix.rows } as CSSProperties}>
      {matrix.cells.map((cell, index) => (
        <button
          type="button"
          key={index}
          className="pixel-cell"
          aria-label={`第 ${Math.floor(index / matrix.columns) + 1} 行，第 ${index % matrix.columns + 1} 列`}
          style={{ backgroundColor: cell.color ? hex(cell.color) : undefined }}
          onClick={() => onCellClick?.(index)}
        >{labels?.[index] ? <span className="score">{labels[index]}</span> : null}</button>
      ))}
    </div>
  );
}
