import { Link } from "react-router-dom";
import type { Entity, Row, Vertical } from "../lib/api";
import { humanize, show, visibleColumns } from "../lib/format";

/**
 * A record's fields in the CRM's two-column detail grid. A field that points at another
 * table links to that row.
 */
export default function DetailsGrid({ entity, row, vertical, showLeftovers }: { entity: Entity; row: Row; vertical: Vertical; showLeftovers?: boolean }) {
  const cols = visibleColumns(entity, { includeLeftovers: showLeftovers });
  return (
    <div className="rounded-card bg-surface-1 border border-border grid sm:grid-cols-2">
      {cols.map((c, i) => (
        <div key={c.name} className={`px-4 py-2.5 ${i >= 2 ? "border-t border-border" : i === 1 ? "border-t sm:border-t-0 border-border" : ""}`}>
          <p className="text-[11px] uppercase tracking-wide text-text-muted flex items-center gap-1">
            {humanize(c.name)}
            {c.leftover && <span className="normal-case tracking-normal text-[10px] text-text-warning">template leftover</span>}
          </p>
          <p className="text-[13px] text-text-primary mt-0.5 break-words">
            {c.links && row[c.name] ? (
              <Link to={`/e/${c.links}/${encodeURIComponent(String(row[c.name]))}`} className="text-text-accent hover:underline">
                {String(row[c.name])}
              </Link>
            ) : (
              show(c, row[c.name], vertical)
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
