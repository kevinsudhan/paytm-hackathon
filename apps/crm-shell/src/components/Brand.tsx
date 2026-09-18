/**
 * Brand lockups — from the Araxys logistics CRM, with the company made a prop.
 *
 * In the template the company was Aashish Logistics Global and its globe mark; a built
 * business brings its own name, and gets a monogram from it instead of a freight globe.
 * The company owns the primary mark. Araxys is
 * the platform underneath, credited quietly — a corner byline, never competing
 * with the customer's own name.
 *
 * The ARAXYS wordmark is set in type rather than shipped as an image: the mark
 * is a thin, wide-tracked geometric uppercase, which CSS reproduces faithfully
 * at the size it is used here, stays sharp on any display, and costs no request.
 * To use the original asset instead, drop it at `public/araxys-wordmark.svg`
 * and swap the <span> in AraxysWordmark for an <img> — nothing else changes.
 */

export function AraxysWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-sans uppercase leading-none ${className}`}
      style={{ fontWeight: 300, letterSpacing: "0.16em" }}
    >
      Araxys
    </span>
  );
}

/** The byline. `tone` picks legible colours for light panels or dark imagery. */
export function PoweredByAraxys({
  tone = "light",
  className = "",
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  const muted = tone === "dark" ? "text-white/40" : "text-text-muted";
  const mark = tone === "dark" ? "text-white/70" : "text-text-secondary";

  return (
    <span className={`inline-flex items-baseline gap-1.5 text-[10px] ${muted} ${className}`}>
      Powered by
      <AraxysWordmark className={`text-[11px] ${mark}`} />
    </span>
  );
}

/**
 * The company lockup: monogram plus name.
 *
 * `stacked` puts the descriptor under the name for the sidebar; inline keeps it
 * on one line for headers where vertical space is tight.
 */
export function CompanyBrand({
  name,
  size = "md",
  descriptor,
  tone = "light",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  descriptor?: string;
  tone?: "light" | "dark";
}) {
  const box = size === "lg" ? "w-9 h-9" : size === "sm" ? "w-7 h-7" : "w-8 h-8";
  const nameSize = size === "lg" ? "text-[16px]" : size === "sm" ? "text-[13px]" : "text-[14px]";
  const nameColor = tone === "dark" ? "text-white" : "text-text-primary";
  const descColor = tone === "dark" ? "text-white/50" : "text-text-muted";
  const markBg = tone === "dark" ? "bg-white/15 backdrop-blur text-white" : "bg-brand text-white";

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`${box} ${markBg} rounded-lg flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <Monogram name={name} />
      </div>
      <div className="min-w-0">
        <p className={`${nameSize} ${nameColor} font-semibold tracking-tight leading-tight truncate`}>
          {name}
        </p>
        {descriptor && <p className={`text-[11px] ${descColor} leading-tight`}>{descriptor}</p>}
      </div>
    </div>
  );
}

/** Up to two initials from the business name, set in the mark's box. */
function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(in|of|the|and|&)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return <span className="text-[11px] font-semibold tracking-wide">{initials || "·"}</span>;
}
