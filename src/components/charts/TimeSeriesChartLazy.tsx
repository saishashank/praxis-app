"use client";

import dynamic from "next/dynamic";
import { ChartTable } from "./ChartTable";

/** Lazy wrapper: the chart code (and Lightweight Charts) loads only where a page renders it. */
export const TimeSeriesChartLazy = dynamic(
  () => import("./TimeSeriesChart").then((m) => m.TimeSeriesChart),
  {
    ssr: false,
    loading: () => (
      <ChartTable
        visible
        caption="Chart loading"
        headers={["Status"]}
        rows={[["Loading chart…"]]}
      />
    ),
  },
);
