import { Series } from "../core/series.js";
import { Timeline } from "../core/timeline.js";

export class DealContext {
  readonly timeline: Timeline;
  private readonly series: Map<string, Series>;
  private readonly metrics: Map<string, number>;
  readonly warnings: string[];

  constructor(timeline: Timeline) {
    this.timeline = timeline;
    this.series = new Map();
    this.metrics = new Map();
    this.warnings = [];
  }

  getSeries(name: string): Series | undefined {
    return this.series.get(name);
  }

  setSeries(name: string, data: Series | number[]): void {
    const series = Array.isArray(data) ? Series.fromArray(data) : data;
    this.series.set(name, series);
  }

  getMetric(name: string): number | undefined {
    return this.metrics.get(name);
  }

  setMetric(name: string, value: number): void {
    this.metrics.set(name, value);
  }

  addWarning(message: string): void {
    this.warnings.push(message);
  }

  toSeriesRecord(): Record<string, number[]> {
    const record: Record<string, number[]> = {};
    for (const [name, series] of this.series.entries()) {
      record[name] = series.toArray();
    }
    return record;
  }

  toMetricsRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [name, value] of this.metrics.entries()) {
      record[name] = value;
    }
    return record;
  }
}
