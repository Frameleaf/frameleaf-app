import React, { useId, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { GiB, calendarWeeks } from "./analytics-data.mjs";
import "./analytics-dashboard.css";

const number = (value) => new Intl.NumberFormat("en-CA").format(value);
const compact = (value) =>
  new Intl.NumberFormat("en-CA", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const tib = (bytes) => `${(bytes / 1024 / GiB).toFixed(2)} TiB`;
const gibText = (bytes) => `${number(Math.round(bytes / GiB))} GiB`;
const percent = (part, whole) => (whole ? (part / whole) * 100 : 0);
const longDate = (value) =>
  new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
const duration = (seconds) =>
  [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part, index) => (index ? String(part).padStart(2, "0") : part))
    .join(":");
const hourLabel = (hour) =>
  hour === 0 ? "12 am" : hour < 12 ? `${hour} am` : hour === 12 ? "12 pm" : `${hour - 12} pm`;

const LONG_DAYS = {
  Mon: "Mondays",
  Tue: "Tuesdays",
  Wed: "Wednesdays",
  Thu: "Thursdays",
  Fri: "Fridays",
  Sat: "Saturdays",
  Sun: "Sundays",
};

// Chart colours: accent first, then the brand teal and blue, then neutrals.
const SERIES = ["var(--an-1)", "var(--an-2)", "var(--an-3)", "var(--an-5)", "var(--an-4)", "var(--an-6)"];

/* ────────────────────────────── small primitives ────────────────────────────── */

function Sparkline({ values, label }) {
  const max = Math.max(1, ...values);
  const points = values
    .map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${30 - (value / max) * 28}`)
    .join(" ");
  return (
    <svg className="an-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label}>
      <polygon points={`0,30 ${points} 100,30`} className="an-spark-fill" />
      <polyline points={points} className="an-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Ring({ value, size = 64, stroke = 7, label, children }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="an-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="an-ring-track" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="an-ring-value"
          strokeWidth={stroke}
          strokeDasharray={`${(Math.min(100, value) / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="an-ring-center">{children}</span>
    </div>
  );
}

function Donut({ segments, size = 168, stroke = 22, label, center }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const whole = segments.reduce((n, segment) => n + segment.value, 0);
  let offset = 0;
  return (
    <div className="an-donut" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="an-ring-track" strokeWidth={stroke} />
        {segments.map((segment, index) => {
          const length = whole ? (segment.value / whole) * circumference : 0;
          const dash = (
            <circle
              key={segment.name}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={segment.color || SERIES[index % SERIES.length]}
              strokeWidth={stroke}
              // A hairline gap between segments reads as separate slices.
              strokeDasharray={`${Math.max(0, length - 1.5)} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>{`${segment.name}: ${number(segment.value)}`}</title>
            </circle>
          );
          offset += length;
          return dash;
        })}
      </svg>
      {center && <span className="an-donut-center">{center}</span>}
    </div>
  );
}

function Legend({ segments, format = number }) {
  const whole = segments.reduce((n, segment) => n + segment.value, 0);
  return (
    <ul className="an-legend">
      {segments.map((segment, index) => (
        <li key={segment.name}>
          <i style={{ background: segment.color || SERIES[index % SERIES.length] }} />
          <span>{segment.name}</span>
          <strong>{format(segment.value)}</strong>
          <small>{percent(segment.value, whole).toFixed(1)}%</small>
        </li>
      ))}
    </ul>
  );
}

// Catch-all rows ("Everywhere else", "Not recorded") sit last and unranked,
// and don't set the bar scale, so they never outshine the real leaders.
const CATCH_ALL = /^(every|not recorded)/i;

function Leaderboard({ rows, renderLead, format = number }) {
  const ranked = rows
    .filter((row) => !CATCH_ALL.test(row.name))
    .sort((a, b) => b.count - a.count);
  const rest = rows.filter((row) => CATCH_ALL.test(row.name));
  const max = Math.max(1, ...ranked.map((row) => row.count));
  return (
    <ol className="an-board">
      {[...ranked, ...rest].map((row, index) => (
        <li key={row.name} className={CATCH_ALL.test(row.name) ? "an-board-rest" : ""}>
          {renderLead ? (
            renderLead(row, index)
          ) : CATCH_ALL.test(row.name) ? (
            <span className="an-rank an-rank-muted">·</span>
          ) : (
            <span className="an-rank">{index + 1}</span>
          )}
          <span className="an-board-name">{row.name}</span>
          <span className="an-board-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (row.count / max) * 100)}%` }} />
          </span>
          <strong>{format(row.count)}</strong>
        </li>
      ))}
    </ol>
  );
}

// One bar split into labelled shares; labels only where a share is wide enough.
function StackBar({ rows, label }) {
  const whole = rows.reduce((n, row) => n + row.count, 0);
  return (
    <div className="an-stack" role="img" aria-label={label}>
      {rows.map((row, index) => (
        <span
          key={row.name}
          style={{ flex: row.count || 0.0001, background: SERIES[index] }}
          title={`${row.name}: ${number(row.count)} (${percent(row.count, whole).toFixed(1)}%)`}
        >
          {percent(row.count, whole) > 8 ? row.name : ""}
        </span>
      ))}
    </div>
  );
}

function MiniStats({ stats }) {
  return (
    <dl className="an-mini-stats">
      {stats.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({ title, kicker, caption, action, onNavigate, className = "", children }) {
  const heading = useId();
  return (
    <section className={`an-panel ${className}`} aria-labelledby={heading}>
      <header className="an-panel-head">
        <div>
          {kicker && <p className="an-kicker">{kicker}</p>}
          <h2 id={heading}>{title}</h2>
          {caption && <p className="an-caption">{caption}</p>}
        </div>
        {action && onNavigate && (
          <button type="button" className="analytics-text-button" onClick={() => onNavigate(action.id)}>
            {action.label}
            <Icon name="mdiChevronRight" size={14} />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

/* ────────────────────────────── sections ────────────────────────────── */

export function LibraryHero({ report, insights }) {
  const { summary, period, series } = report;
  const used = percent(summary.volumeUsedBytes, summary.capacityBytes);
  const facts = [
    ["mdiEarth", `${insights.countries} countries`],
    ["mdiMapMarkerMultipleOutline", `${number(insights.cities)} places`],
    ["mdiAccountGroupOutline", `${insights.namedPeople} people named`],
    ["mdiCameraIris", `${number(summary.raw)} RAW photos`],
    ["mdiHdr", `${number(insights.dolbyVision)} Dolby Vision videos`],
    ["mdiMovieOpenOutline", `${number(insights.records.watchHours)} hours of video`],
  ];
  return (
    <section className="an-hero" aria-label="Library at a glance">
      <div className="an-hero-main">
        <p className="an-kicker">Your library</p>
        <p className="an-hero-number">{number(summary.items)}</p>
        <p className="an-hero-line">
          photos and videos across <strong>{insights.span.years} years</strong> of memories,{" "}
          {insights.span.from}–{insights.span.through}
        </p>
        <ul className="an-facts">
          {facts.map(([icon, text]) => (
            <li key={text}>
              <Icon name={icon} size={15} />
              {text}
            </li>
          ))}
        </ul>
      </div>
      <div className="an-kpis">
        <div className="an-kpi">
          <span>Added this period</span>
          <strong>+{number(period.items)}</strong>
          <Sparkline
            values={series.map((row) => row.photos + row.videos)}
            label={`Arrivals per period, ${series.length} periods`}
          />
        </div>
        <div className="an-kpi an-kpi-ring">
          <Ring value={used} label={`${used.toFixed(0)}% of the volume used`}>
            {used.toFixed(0)}%
          </Ring>
          <div>
            <span>Volume used</span>
            <strong>{tib(summary.volumeUsedBytes)}</strong>
            <small>of {tib(summary.capacityBytes)} · {tib(summary.freeBytes)} free</small>
          </div>
        </div>
        <div className="an-kpi">
          <span>Saved by deduplication</span>
          <strong>{gibText(summary.savedBytes)}</strong>
          <small>
            {number(summary.duplicateReferences)} items share an original with another
          </small>
        </div>
        <div className="an-kpi">
          <span>Photos · videos</span>
          <strong>
            {compact(summary.photos)} · {compact(summary.videos)}
          </strong>
          <span className="an-split" aria-hidden="true">
            <span style={{ width: `${percent(summary.photos, summary.items)}%` }} />
          </span>
        </div>
      </div>
    </section>
  );
}

export function YearsChart({ insights }) {
  const max = Math.max(1, ...insights.years.map((row) => row.count));
  const best = insights.years.reduce((a, b) => (b.count > a.count ? b : a));
  return (
    <Panel
      kicker="Through the years"
      title={`${insights.span.years} years, ${insights.span.from} to today`}
      caption={`Your biggest year was ${best.year}, with ${number(best.count)} photos and videos. ${insights.span.through} so far is shown lighter.`}
      className="an-wide"
    >
      <div className="an-years" role="img" aria-label="Photos and videos captured each year">
        {insights.years.map((row) => (
          <div key={row.year} className={`an-year ${row.partial ? "partial" : ""} ${row === best ? "best" : ""}`}>
            <span className="an-year-value">{compact(row.count)}</span>
            <span className="an-year-bar" style={{ height: `${(row.count / max) * 100}%` }} title={`${row.year}: ${number(row.count)}`} />
            <span className="an-year-label">{String(row.year).slice(2)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function ShootingHabits({ insights }) {
  const max = Math.max(1, ...insights.punchcard.flatMap((row) => row.hours));
  return (
    <Panel
      kicker="When you shoot"
      title={`Most often on ${LONG_DAYS[insights.peak.day]} around ${hourLabel(insights.peak.hour)}`}
      caption="Every photo and video by the day and hour it was taken."
    >
      <div className="an-punch" role="img" aria-label="Captures by weekday and hour">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="an-punch-hour">
            {hour % 6 === 0 ? hourLabel(hour) : ""}
          </span>
        ))}
        {insights.punchcard.map((row) => (
          <React.Fragment key={row.day}>
            <span className="an-punch-day">{row.day}</span>
            {row.hours.map((count, hour) => (
              <span key={hour} className="an-punch-cell" title={`${row.day} ${hourLabel(hour)}: ${number(count)}`}>
                <i style={{ "--s": Math.sqrt(count / max) }} />
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
    </Panel>
  );
}

export function CaptureHeatmap({ report }) {
  const [type, setType] = useState("captured");
  const plotted = useMemo(
    () => report.days.map((row) => ({ ...row, captured: row[type] })),
    [report, type],
  );
  const weeks = useMemo(() => (plotted.length ? calendarWeeks(plotted) : []), [plotted]);
  const max = Math.max(1, ...plotted.map((row) => row.captured));
  const total = plotted.reduce((n, row) => n + row.captured, 0);
  const noun = type === "uploaded" ? "uploads" : "captures";
  return (
    <Panel
      kicker="Every day"
      title={`${number(total)} ${noun} over ${plotted.length} days`}
      caption="Darker squares are busier days. Hover a square for its exact count."
      className="an-wide"
    >
      <label className="an-inline-select">
        Show
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="captured">Date taken</option>
          <option value="uploaded">Date uploaded</option>
        </select>
      </label>
      <div className="an-heat-scroll">
        <div className="an-heat" style={{ "--weeks": weeks.length }} role="img" aria-label={`${noun} per day`}>
          {weeks.map((week) =>
            week.map((cell) => (
              <span
                key={cell.date}
                className="an-heat-cell"
                data-level={cell.captured === null ? "none" : Math.min(4, Math.ceil((cell.captured / max) * 4))}
                title={cell.captured === null ? cell.date : `${longDate(cell.date)}: ${number(cell.captured)} ${noun}`}
              />
            )),
          )}
        </div>
      </div>
      <div className="an-heat-legend" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className="an-heat-cell" data-level={level} />
        ))}
        More
      </div>
      {/* Exact counts without relying on colour or hover. */}
      <details className="analytics-data-table">
        <summary>View daily counts</summary>
        <div className="analytics-table-scroll" tabIndex={0} role="region" aria-label={`Daily ${noun}`}>
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">{type === "uploaded" ? "Uploaded" : "Taken"}</th>
              </tr>
            </thead>
            <tbody>
              {plotted.map((row) => (
                <tr key={row.date}>
                  <th scope="row">{longDate(row.date)}</th>
                  <td>{number(row.captured)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}

export function GearPanel({ report, insights }) {
  const focalMax = Math.max(1, ...insights.focalLengths.map((row) => row.count));
  return (
    <Panel kicker="Your gear" title="Cameras and lenses" caption="What took the photos, and the focal lengths you reach for.">
      <Leaderboard rows={report.cameras.map((row) => ({ name: row.name, count: row.count }))} />
      <h3 className="an-subhead">Favourite lenses</h3>
      <Leaderboard rows={insights.lenses} />
      <h3 className="an-subhead">Focal lengths</h3>
      <div className="an-focal" role="img" aria-label="Photos by focal length">
        {insights.focalLengths.map((row) => (
          <div key={row.name} title={`${row.name}: ${number(row.count)}`}>
            <span style={{ height: `${(row.count / focalMax) * 100}%` }} />
            <small>{row.name.replace("mm", "")}</small>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function FormatsPanel({ report, insights }) {
  const segments = insights.photoFormats.map((row) => ({ name: row.name, value: row.count }));
  return (
    <Panel
      kicker="Formats & quality"
      title="What your originals are made of"
      caption="Photo formats by count, video by resolution. Originals are always kept as they arrived."
    >
      <div className="an-donut-row">
        <Donut
          segments={segments}
          label="Photo formats"
          center={
            <>
              <strong>{compact(report.summary.photos)}</strong>
              <small>photos</small>
            </>
          }
        />
        <Legend segments={segments} />
      </div>
      <h3 className="an-subhead">Video resolution</h3>
      <StackBar rows={insights.videoResolutions} label="Videos by resolution" />
      <h3 className="an-subhead">Photo orientation</h3>
      <StackBar rows={insights.orientation} label="Photos by orientation" />
      <ul className="an-chips">
        <li>
          <Icon name="mdiMotionPlayOutline" size={15} /> {number(insights.livePhotos)} Live Photos
        </li>
        <li>
          <Icon name="mdiHdr" size={15} /> {number(insights.hdr)} HDR videos
        </li>
        <li>
          <Icon name="mdiDolby" size={15} /> {number(insights.dolbyVision)} Dolby Vision
        </li>
        <li>
          <Icon name="mdiCameraIris" size={15} /> {number(report.summary.raw)} RAW photos
        </li>
      </ul>
    </Panel>
  );
}

export function PeoplePlacesPanel({ insights, onNavigate }) {
  return (
    <>
      <Panel
        kicker="People"
        title={`${number(insights.facesDetected)} faces found`}
        caption={`${insights.namedPeople} people have names. Who appears most:`}
        action={{ id: "intelligence", label: "Recognition" }}
        onNavigate={onNavigate}
      >
        <Leaderboard
          rows={insights.people}
          renderLead={(row) =>
            row.image ? (
              <PersonAvatar person={row} size={32} />
            ) : (
              <span className="an-rank an-rank-muted">
                <Icon name="mdiAccountGroupOutline" size={16} />
              </span>
            )
          }
        />
        <MiniStats
          stats={[
            ["Photos with people", number(insights.photosWithFaces)],
            ["Faces per photo", insights.facesPerPhoto],
            ["Pets recognized", insights.pets],
          ]}
        />
      </Panel>
      <Panel
        kicker="Places"
        title={`${insights.countries} countries, ${number(insights.cities)} places`}
        caption={`${number(insights.geotagged)} photos and videos have a location. Where they were taken:`}
      >
        <Leaderboard rows={insights.places} />
      </Panel>
    </>
  );
}

export function CoveragePanel({ insights, onNavigate }) {
  return (
    <Panel
      kicker="How well the library knows itself"
      title="Coverage"
      caption="The share of your library each kind of understanding has reached."
      action={{ id: "care", label: "Library care" }}
      onNavigate={onNavigate}
      className="an-wide"
    >
      <div className="an-rings">
        {insights.coverage.map((row) => (
          <div key={row.name}>
            <Ring value={row.percent} size={86} stroke={8} label={`${row.name}: ${row.percent}%`}>
              {Math.round(row.percent)}%
            </Ring>
            <span>{row.name}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function RecordsPanel({ insights }) {
  const { records } = insights;
  const years = 2026 - Number(records.oldest.slice(0, 4));
  const cards = [
    ["mdiClockTimeEightOutline", "Oldest memory", longDate(records.oldest), `${years} years ago`],
    records.busiestDay && [
      "mdiFire",
      "Busiest day",
      `${number(records.busiestDay.count)} items`,
      longDate(records.busiestDay.date),
    ],
    records.streak.length > 0 && [
      "mdiCalendarCheckOutline",
      "Longest streak",
      `${number(records.streak.length)} days`,
      `${longDate(records.streak.from)} – ${longDate(records.streak.through)}`,
    ],
    ["mdiChartLine", "Daily average", `${number(records.perDay)} a day`, "In the selected dates"],
    records.largestFile && [
      "mdiFileVideoOutline",
      "Largest file",
      `${(records.largestFile.bytes / GiB).toFixed(1)} GiB`,
      records.largestFile.name,
    ],
    records.longestVideo && [
      "mdiTimerOutline",
      "Longest video",
      duration(records.longestVideo.seconds),
      records.longestVideo.name,
    ],
    ["mdiLayersTripleOutline", "Printed and stacked", `${records.printStackMetres} m tall`, "Every photo as a 6×4 print"],
    ["mdiRuler", "Laid end to end", `${records.printLineKm} km`, "The same prints, in a line"],
  ].filter(Boolean);
  return (
    <Panel kicker="Records & milestones" title="Library records" className="an-wide">
      <div className="an-records">
        {cards.map(([icon, label, value, detail]) => (
          <div key={label} className="an-record">
            <Icon name={icon} size={20} />
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function StoragePanel({ report, onNavigate }) {
  const { summary } = report;
  const segments = [
    ...report.storage.map((row, index) => ({
      name: row.name,
      value: row.bytes,
      color: SERIES[index],
    })),
    { name: "Free", value: summary.freeBytes, color: "var(--an-free)" },
  ];
  const used = percent(summary.volumeUsedBytes, summary.capacityBytes);
  return (
    <Panel
      kicker="Storage"
      title={`${tib(summary.volumeUsedBytes)} of ${tib(summary.capacityBytes)} used`}
      caption="The whole volume, including previews, the database and every library on the server."
      action={{ id: "storage", label: "Storage settings" }}
      onNavigate={onNavigate}
    >
      <div className="an-donut-row">
        <Donut
          segments={segments}
          label="Volume usage"
          center={
            <>
              <strong>{used.toFixed(0)}%</strong>
              <small>used</small>
            </>
          }
        />
        <Legend segments={segments} format={(value) => gibText(value)} />
      </div>
    </Panel>
  );
}
