import { useId, type InputHTMLAttributes } from "react";
import { cx } from "../cx";

export interface EffortSliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max" | "step"> {
  /** Ordered stops, weakest first (host order: low → ultra). */
  levels: readonly string[];
  /** Current stop; an unknown value snaps to the first stop. */
  value: string | null;
  onValueChange: (level: string) => void;
  /** Label above the track; the current stop is appended. */
  label?: string;
  /** Left / right end captions, e.g. 更快 / 更深入. */
  minLabel?: string;
  maxLabel?: string;
}

/**
 * 推理强度拉条：与宿主 composer 的档位拉条同构（27px 轨道、每档一个刻度、
 * 填充到滑块右缘），但用原生 `input[type=range]` 实现——插件包只 peer 依赖
 * react，不引 react-aria/motion，键盘与拖拽行为直接由浏览器提供。
 *
 * 样式全部消费宿主语义 token（见 ../tokens.ts 契约），深浅色跟随宿主翻转。
 */
export function EffortSlider({
  levels,
  value,
  onValueChange,
  label,
  minLabel,
  maxLabel,
  className,
  disabled,
  ...rest
}: EffortSliderProps) {
  const headingId = useId();
  const last = Math.max(0, levels.length - 1);
  const index = Math.max(0, levels.indexOf(value ?? ""));
  // 滑块宽 21px：中心在 21px 内缩轨道的 fraction 处，填充宽用 calc 贴住右缘，
  // 任意渲染宽度下刻度都落在档位上。
  const fraction = last === 0 ? 0 : index / last;

  return (
    <div className={cx("pui-effort", disabled && "pui-effort-disabled", className)}>
      {label && (
        <div className="pui-effort-heading" id={headingId}>
          {label}
          <strong>{levels[index] ?? "—"}</strong>
        </div>
      )}
      <div className="pui-effort-track">
        <div className="pui-effort-fill" style={{ width: `calc(${fraction} * (100% - 21px) + 21px)` }} />
        <div className="pui-effort-ticks" aria-hidden>
          {levels.map((level, i) => (
            <span key={level} className={cx("pui-effort-tick", i > index && "pui-effort-tick-dim")} />
          ))}
        </div>
        <input
          className="pui-effort-input"
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={disabled}
          aria-labelledby={label ? headingId : undefined}
          // 读屏播报档位名而不是裸数字
          aria-valuetext={levels[index]}
          onChange={(event) => {
            const next = levels[Number(event.target.value)];
            if (next !== undefined) onValueChange(next);
          }}
          {...rest}
        />
      </div>
      {(minLabel || maxLabel) && (
        <div className="pui-effort-ends">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}
