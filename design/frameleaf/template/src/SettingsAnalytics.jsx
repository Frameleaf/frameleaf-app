import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import { Icon } from "./Icon";
import {
  ANALYTICS_SNAPSHOT,
  GiB,
  analyticsCsv,
  getAnalytics,
} from "./analytics-data.mjs";
import {
  getScopeOptions,
  loadResourceState,
  subscribeResourceState,
} from "./account-library-data.mjs";
import { libraryInsights } from "./library-insights.mjs";
import {
  CaptureHeatmap,
  CoveragePanel,
  FormatsPanel,
  GearPanel,
  LibraryHero,
  PeoplePlacesPanel,
  RecordsPanel,
  ShootingHabits,
  StoragePanel,
  YearsChart,
} from "./AnalyticsDashboard";
import "./settings-analytics.css";

function useResources() {
  const [resources, setResources] = useState(loadResourceState);
  useEffect(() => subscribeResourceState(setResources), []);
  return resources;
}

const number = (value) =>
  new Intl.NumberFormat("en-CA", { maximumFractionDigits: 12 }).format(value);
const gib = (bytes) => `${number(Number((bytes / GiB).toFixed(2)))} GiB`;
const date = (value) =>
  new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
const span = (report) => `${date(report.from)} – ${date(report.through)}`;

function DataTable({ title, columns, rows }) {
  return (
    <details className="analytics-data-table">
      <summary aria-label={`View data table for ${title}`}>
        View data table
      </summary>
      <div
        className="analytics-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${title} data`}
      >
        <table>
          <caption>{title} · exact plotted values</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) =>
                  j === 0 ? (
                    <th key={j} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td key={j}>
                      {typeof cell === "number" ? number(cell) : cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function CanvasChart({
  title,
  type = "bar",
  labels,
  datasets,
  horizontal = false,
  stacked = false,
  unit = "items",
  height = 240,
  compact = false,
}) {
  const canvas = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let chart;
    const draw = () => {
      chart?.destroy();
      const css = getComputedStyle(element);
      const text = css.getPropertyValue("--fl-muted").trim() || "#8b969f";
      const grid = css.getPropertyValue("--fl-border").trim() || "#303a42";
      const palette = {
        primary: css.getPropertyValue("--fl-accent").trim() || "#47b481",
        secondary: "#7f96a8",
        missing: "#647078",
        failure: "#bf856f",
      };
      const light = element.closest("[data-theme]")?.dataset.theme === "light";
      // Canvas text needs the real UI stack; a bare "Inter" falls back to serif.
      const family = getComputedStyle(element).fontFamily;
      try {
        chart = new Chart(element, {
          type,
          data: {
            labels,
            datasets: datasets.map(({ tone = "primary", ...dataset }) => ({
              borderColor: palette[tone],
              backgroundColor: dataset.fill
                ? light
                  ? "rgba(58, 148, 107, 0.12)"
                  : "rgba(83, 179, 130, 0.12)"
                : palette[tone],
              borderWidth: type === "line" ? 2 : 0,
              borderRadius: type === "bar" ? 2 : 0,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHitRadius: 12,
              tension: 0.25,
              ...dataset,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            normalized: true,
            indexAxis: horizontal ? "y" : "x",
            interaction: {
              mode: "index",
              intersect: false,
              axis: horizontal ? "y" : "x",
            },
            layout: { padding: { top: 8, right: 8 } },
            plugins: {
              legend: {
                display: !compact && datasets.length > 1,
                position: "bottom",
                align: "start",
                labels: {
                  color: text,
                  boxWidth: 8,
                  boxHeight: 8,
                  padding: 18,
                  font: { family, size: 11 },
                },
              },
              tooltip: {
                padding: 12,
                displayColors: datasets.length > 1,
                backgroundColor: light ? "#20282f" : "#e9eef0",
                titleColor: light ? "#fff" : "#172027",
                bodyColor: light ? "#e5ecef" : "#172027",
                callbacks: {
                  label: (context) =>
                    `${context.dataset.label}: ${number(horizontal ? context.parsed.x : context.parsed.y)} ${unit}`,
                },
              },
            },
            scales: {
              x: {
                stacked,
                grid: { color: grid, display: horizontal },
                border: { display: false },
                ticks: {
                  color: text,
                  maxRotation: 0,
                  autoSkip: true,
                  maxTicksLimit: compact ? 4 : 7,
                  font: { family, size: 10 },
                  ...(horizontal
                    ? {
                        callback: (value) => number(value),
                      }
                    : {}),
                },
                ...(horizontal ? { beginAtZero: true } : {}),
              },
              y: {
                stacked,
                grid: { color: grid, display: !horizontal },
                border: { display: false },
                beginAtZero: type !== "line",
                ticks: {
                  color: text,
                  maxTicksLimit: compact ? 3 : 5,
                  font: { family, size: 10 },
                  ...(!horizontal
                    ? {
                        callback: (value) => number(value),
                      }
                    : {}),
                },
              },
            },
          },
        });
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    draw();
    const themeRoot =
      element.closest("[data-theme]") || document.documentElement;
    const observer = new MutationObserver(draw);
    observer.observe(themeRoot, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => {
      observer.disconnect();
      chart?.destroy();
    };
  }, [type, labels, datasets, horizontal, stacked, unit, compact]);
  return (
    <div className="analytics-canvas" style={{ height }}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${title}. Exact values are available in the data table below.`}
      >
        {title}. Use the data table for the plotted values.
      </canvas>
      {failed && (
        <p className="analytics-chart-error" role="status">
          Chart unavailable. The data table below contains every value.
        </p>
      )}
    </div>
  );
}

function Card({
  title,
  caption,
  action,
  onNavigate,
  children,
  className = "",
}) {
  const heading = useId();
  return (
    <section
      className={`analytics-card ${className}`}
      aria-labelledby={heading}
    >
      <header className="analytics-card-heading">
        <div>
          <h2 id={heading}>{title}</h2>
          {caption && <p>{caption}</p>}
        </div>
        {action && onNavigate && (
          <button
            type="button"
            className="analytics-text-button"
            onClick={() => onNavigate(action.id)}
          >
            {action.label}
            <Icon name="mdiChevronRight" size={14} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

export function LibraryGrowthChart({
  compact = false,
  range = "year",
  scope = "all",
  metric = "items",
}) {
  const resources = useResources();
  const report = useMemo(
    () => getAnalytics({ range, scope, resources }),
    [range, scope, resources],
  );
  const storage = metric === "storage";
  const labels = useMemo(() => report.series.map((row) => row.label), [report]);
  const datasets = useMemo(
    () =>
      storage
        ? [
            {
              label: "Physical originals",
              data: report.series.map((row) => row.physicalGiB),
              fill: true,
            },
            {
              label: "Logical originals",
              data: report.series.map((row) => row.logicalGiB),
              tone: "secondary",
              borderDash: [4, 4],
            },
          ]
        : [
            {
              label: "Library",
              data: report.series.map((row) => row.items),
              fill: true,
            },
          ],
    [report, storage],
  );
  return (
    <figure
      className={`analytics-growth ${compact ? "analytics-growth-compact" : ""}`}
    >
      <figcaption>
        <div>
          <span>Library growth</span>
          <strong>
            {storage
              ? gib(report.summary.physicalBytes)
              : `${number(report.summary.items)} items`}
          </strong>
        </div>
        <small>
          {report.scopeLabel} · {span(report)}
        </small>
      </figcaption>
      <CanvasChart
        title={`Cumulative ${storage ? "original storage" : "library item count"}`}
        type="line"
        labels={labels}
        datasets={datasets}
        unit={storage ? "GiB" : "items"}
        height={compact ? 170 : 260}
        compact={compact}
      />
      <p className="analytics-chart-note">
        {storage
          ? "Physical bytes after deduplication; logical bytes count every original reference."
          : `+${number(report.period.items)} items imported in this period.`}
      </p>
      <DataTable
        title="Library growth"
        columns={
          storage
            ? ["Through", "Physical GiB", "Logical GiB"]
            : ["Through", "Items"]
        }
        rows={report.series.map((row) =>
          storage
            ? [row.through, row.physicalGiB, row.logicalGiB]
            : [row.through, row.items],
        )}
      />
    </figure>
  );
}

export function SettingsAnalytics({
  onNavigate,
  scope: controlledScope,
  onScopeChange,
}) {
  const [range, setRange] = useState("year");
  const [localScope, setLocalScope] = useState("all");
  const resources = useResources();
  const options = getScopeOptions(resources);
  const requestedScope = controlledScope ?? localScope;
  const scope = options.some((option) => option.value === requestedScope)
    ? requestedScope
    : "all";
  const setScope = (value) => {
    setLocalScope(value);
    onScopeChange?.(value);
  };
  const [metric, setMetric] = useState("items");
  const [exportStatus, setExportStatus] = useState("");
  const report = useMemo(
    () => getAnalytics({ range, scope, resources }),
    [range, scope, resources],
  );
  const insights = useMemo(() => libraryInsights(report), [report]);
  const { summary, period } = report;
  const labels = report.series.map((row) => row.label);
  const exportCsv = () => {
    try {
      const blob = new Blob([analyticsCsv(report, metric)], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `frameleaf-sample-analytics-${scope}-${range}-${metric}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus(
        "CSV download started. Your selected dates, library and chart values are included.",
      );
    } catch {
      setExportStatus(
        "The browser could not start the CSV download. All values remain available in the tables.",
      );
    }
  };
  const geekRows = [
    ["RAW photos", summary.raw, "Subset of photos"],
    [
      "HDR videos",
      summary.hdrVideos,
      "Subset of videos; overlaps codecs below",
    ],
    ["Variable-frame-rate videos", summary.vfrVideos, "Subset of videos"],
    ...report.codecs.map((row) => [
      row.name,
      row.count,
      "Codec groups partition all videos",
    ]),
    [
      "Deduplicated references",
      summary.duplicateReferences,
      "Library items that share an original file",
    ],
    [
      "Logical originals",
      `${number(summary.logicalBytes)} bytes`,
      "Every referenced original, before physical deduplication",
    ],
    [
      "Physical originals",
      `${number(summary.physicalBytes)} bytes`,
      "Space used by original files after deduplication",
    ],
    [
      "Original bytes saved",
      `${number(summary.savedBytes)} bytes`,
      "Logical minus physical; excludes derivatives",
    ],
    [
      "Estimated cloud processing",
      `$${period.cloudEstimateUsd.toFixed(2)} USD`,
      `${number(period.attempts)} attempts × $${period.cloudRateUsdPerAttempt} per attempt. Assumes all processing uses cloud. Estimate only, not a bill.`,
    ],
  ];
  return (
    <div className="settings-analytics">
      <header className="analytics-page-heading">
        <div>
          <p className="analytics-eyebrow">Command center</p>
          <h1>Library analytics</h1>
          <p>How it grows, what it holds, and the work behind it.</p>
        </div>
        <button type="button" className="analytics-export" onClick={exportCsv}>
          Export CSV <Icon name="mdiDownload" size={16} />
        </button>
      </header>
      <div className="analytics-demo-notice">
        <span className="analytics-demo-badge">Sample data</span>
        <p>Library overview as of {date(ANALYTICS_SNAPSHOT)}.</p>
      </div>
      <div className="analytics-controls">
        <label>
          Date range
          <select
            value={range}
            onChange={(event) => {
              setRange(event.target.value);
              setExportStatus("");
            }}
          >
            <option value="90days">90 days</option>
            <option value="year">12 months</option>
          </select>
        </label>
        <label>
          Library scope
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setExportStatus("");
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Growth metric
          <select
            value={metric}
            onChange={(event) => {
              setMetric(event.target.value);
              setExportStatus("");
            }}
          >
            <option value="items">Items</option>
            <option value="storage">Original storage</option>
          </select>
        </label>
        <p>
          History: {span(report)}
          <br />
          Inventory and storage: latest snapshot
        </p>
      </div>
      <p className="analytics-export-status" role="status">
        {exportStatus}
      </p>
      <LibraryHero report={report} insights={insights} />
      <div className="analytics-card analytics-growth-card">
        <LibraryGrowthChart range={range} scope={scope} metric={metric} />
      </div>
      <div className="an-dashboard">
        <YearsChart insights={insights} />
        <ShootingHabits insights={insights} />
        <StoragePanel report={report} onNavigate={onNavigate} />
        <CaptureHeatmap report={report} />
        <GearPanel report={report} insights={insights} />
        <FormatsPanel report={report} insights={insights} />
        <PeoplePlacesPanel insights={insights} onNavigate={onNavigate} />
        <CoveragePanel insights={insights} onNavigate={onNavigate} />
        <RecordsPanel insights={insights} />
      </div>
      <div className="analytics-grid">
        <Card
          title="Coming into the library"
          caption="Photos and videos imported during the selected dates. The first and last periods may be shorter."
        >
          <CanvasChart
            title="Photo and video arrivals"
            labels={labels}
            stacked
            datasets={[
              { label: "Photos", data: report.series.map((row) => row.photos) },
              {
                label: "Videos",
                data: report.series.map((row) => row.videos),
                tone: "secondary",
              },
            ]}
          />
          <DataTable
            title="Arrivals"
            columns={["Period", "Photos", "Videos"]}
            rows={report.series.map((row) => [
              `${row.from} – ${row.through}`,
              row.photos,
              row.videos,
            ])}
          />
        </Card>
        <Card
          title="Work happening in the background"
          caption={`${number(period.attempts)} processing attempts · ${period.successPercent}% completed · ${number(period.failed)} failed.`}
          action={{ id: "processing", label: "Processing" }}
          onNavigate={onNavigate}
        >
          <CanvasChart
            title="Processing outcomes"
            labels={labels}
            stacked
            unit="attempts"
            datasets={[
              {
                label: "Completed",
                data: report.series.map((row) => row.completed),
              },
              {
                label: "Failed",
                data: report.series.map((row) => row.failed),
                tone: "failure",
              },
            ]}
          />
          <p className="analytics-chart-note">
            Each attempt is counted once. A photo or video can have several
            processing steps.
          </p>
          <DataTable
            title="Processing attempts"
            columns={["Period", "Completed", "Failed"]}
            rows={report.series.map((row) => [
              `${row.from} – ${row.through}`,
              row.completed,
              row.failed,
            ])}
          />
        </Card>
        <Card
          title="How much the library knows"
          caption="Present and missing metadata across the current inventory. Missing GPS can be intentional."
          action={{ id: "intelligence", label: "Intelligence" }}
          onNavigate={onNavigate}
          className="analytics-wide"
        >
          <CanvasChart
            title="Metadata completeness"
            horizontal
            stacked
            labels={report.metadata.map((row) => row.name)}
            datasets={[
              {
                label: "Present",
                data: report.metadata.map((row) => row.present),
              },
              {
                label: "Missing",
                data: report.metadata.map((row) => row.missing),
                tone: "missing",
              },
            ]}
            height={220}
          />
          <DataTable
            title="Metadata completeness"
            columns={["Field", "Present", "Missing", "Complete %"]}
            rows={report.metadata.map((row) => [
              row.name,
              row.present,
              row.missing,
              row.percent,
            ])}
          />
        </Card>
      </div>
      <div className="analytics-card">
        <Card
          className="analytics-library-views"
          title="Where your photos live"
          caption="Timeline, Archive and Trash partition this dated snapshot. Favorites overlap Timeline and Archive."
        >
          <DataTable
            title="Library collections"
            columns={["View", "Photos", "Videos", "Total"]}
            rows={[
              ...report.collections.map((row) => [
                row.name,
                row.photos,
                row.videos,
                row.total,
              ]),
              [
                "All retained items",
                summary.photos,
                summary.videos,
                summary.items,
              ],
            ]}
          />
          <dl className="analytics-stat-strip">
            {report.collections.map((row) => (
              <div key={row.name}>
                <dt>{row.name}</dt>
                <dd>{number(row.total)}</dd>
                <span>
                  {row.overlaps
                    ? "Also counted in other views"
                    : `${number(row.photos)} photos · ${number(row.videos)} videos`}
                </span>
              </div>
            ))}
          </dl>
        </Card>
        <Card
          className="analytics-album-views"
          title="Albums, owned and shared"
          caption="Shared albums include albums you own and albums shared with you. These counts overlap; an album can contain photos from several libraries."
        >
          <dl className="analytics-stat-strip">
            <div>
              <dt>Owned</dt>
              <dd>{number(report.albumCounts.owned)}</dd>
              <span>{number(report.albumCounts.notShared)} private</span>
            </div>
            <div>
              <dt>Shared</dt>
              <dd>{number(report.albumCounts.shared)}</dd>
              <span>{number(report.albumCounts.ownedShared)} also owned</span>
            </div>
            <div>
              <dt>Distinct albums</dt>
              <dd>{number(report.albumCounts.total)}</dd>
              <span>Counted once each</span>
            </div>
          </dl>
          <DataTable
            title="Album membership"
            columns={["Album", "Owner", "Ownership", "Sharing"]}
            rows={report.albums.map((album) => [
              album.name,
              album.ownerName,
              album.owned ? "Owned" : "Member",
              album.shared ? "Shared" : "Private",
            ])}
          />
        </Card>
      </div>
      <Card
        title="Under the hood"
        caption="Photo formats, video characteristics and storage details."
        action={{ id: "care", label: "Library care" }}
        onNavigate={onNavigate}
      >
        <div
          className="analytics-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Media and storage inventory"
        >
          <table className="analytics-geek-table">
            <caption>
              {report.scopeLabel} · {date(report.through)}
            </caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Value</th>
                <th scope="col">Definition</th>
              </tr>
            </thead>
            <tbody>
              {geekRows.map(([name, value, definition]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{typeof value === "number" ? number(value) : value}</td>
                  <td>{definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <footer className="analytics-footnote">
        <strong>About these numbers</strong>
        <p>
          The date range applies to growth, imports, captures and processing.
          Storage, cameras, formats and metadata show the library as of{" "}
          {date(ANALYTICS_SNAPSHOT)}. Volume usage includes every library on the
          server. The 12-month view starts in October 2025 and ends on September
          19, 2026.
        </p>
      </footer>
    </div>
  );
}
