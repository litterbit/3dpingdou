export function Field({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
