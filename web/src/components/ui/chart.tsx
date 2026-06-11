import * as React from "react";
import {
  Legend,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
} from "recharts";
import { cn } from "../../lib/utils";

export type ChartConfig = Record<
  string,
  { label?: string; color?: string }
>;

interface ChartContextValue {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used inside ChartContainer");
  return ctx;
}

// 将 config 颜色映射为 CSS 变量注入 style
function buildColorVars(config: ChartConfig): React.CSSProperties {
  const vars: Record<string, string> = {};
  for (const [key, val] of Object.entries(config)) {
    if (val.color) vars[`--color-${key}`] = val.color;
  }
  return vars as React.CSSProperties;
}

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { config: ChartConfig; children: React.ReactNode }
>(({ id, className, children, config, ...props }, ref) => {
  const chartId = `chart-${id ?? React.useId().replace(/:/g, "")}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        ref={ref}
        data-chart={chartId}
        className={cn("flex aspect-video justify-center text-xs", className)}
        style={buildColorVars(config)}
        {...props}
      >
        <ResponsiveContainer>{children as React.ReactElement}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});
ChartContainer.displayName = "ChartContainer";

// ── Tooltip ───────────────────────────────────────────────────────────────────

const ChartTooltip = Tooltip;

const ChartTooltipContent = React.forwardRef<
  HTMLDivElement,
  TooltipProps<number | string, string> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "dot" | "line" | "dashed";
    nameKey?: string;
    labelKey?: string;
    className?: string;
  }
>(
  (
    {
      active,
      payload,
      className,
      indicator = "dot",
      hideLabel = false,
      hideIndicator = false,
      label,
      labelKey,
      nameKey,
    },
    ref,
  ) => {
    const { config } = useChart();

    if (!active || !payload?.length) return null;

    return (
      <div
        ref={ref}
        className={cn(
          "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-[var(--color-border,hsl(var(--border)))] bg-[var(--color-background,hsl(var(--background)))] px-2.5 py-1.5 text-xs shadow-xl",
          className,
        )}
      >
        {!hideLabel && label && (
          <div className="font-medium">{labelKey ? config[labelKey]?.label ?? label : label}</div>
        )}
        <div className="grid gap-1.5">
          {payload.map((item) => {
            const key = nameKey ?? item.dataKey ?? item.name ?? "value";
            const itemConfig = typeof key === "string" ? config[key] : undefined;
            const indicatorColor = item.color ?? itemConfig?.color;

            return (
              <div
                key={item.dataKey ?? item.name}
                className="flex w-full flex-wrap items-stretch gap-2"
              >
                {!hideIndicator && (
                  <div
                    className={cn(
                      "shrink-0 rounded-[2px]",
                      indicator === "dot" && "mt-0.5 h-2.5 w-2.5",
                      indicator === "line" && "w-1",
                      indicator === "dashed" && "w-0 border-[1.5px] border-dashed",
                    )}
                    style={{ background: indicatorColor, borderColor: indicatorColor }}
                  />
                )}
                <div className="flex flex-1 justify-between leading-none">
                  <span className="text-[var(--color-muted-foreground,hsl(var(--muted-foreground)))]">
                    {itemConfig?.label ?? item.name}
                  </span>
                  {item.value != null && (
                    <span className="font-mono font-medium tabular-nums">
                      {item.value.toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);
ChartTooltipContent.displayName = "ChartTooltipContent";

// ── Legend ────────────────────────────────────────────────────────────────────

const ChartLegend = Legend;

const ChartLegendContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { payload?: Array<{ value: string; color?: string }> }
>(({ className, payload }, ref) => {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div ref={ref} className={cn("flex items-center justify-center gap-4 pt-3 text-xs", className)}>
      {payload.map((item) => {
        const itemConfig = config[item.value];
        return (
          <div key={item.value} className="flex items-center gap-1.5">
            <div
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: item.color ?? itemConfig?.color }}
            />
            {itemConfig?.label ?? item.value}
          </div>
        );
      })}
    </div>
  );
});
ChartLegendContent.displayName = "ChartLegendContent";

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
};
