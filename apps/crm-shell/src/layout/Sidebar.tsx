import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { CompanyBrand, PoweredByAraxys } from "../components/Brand";
import { useApp } from "../lib/app";
import { api, type Role } from "../lib/api";
import {
  LayoutDashboard,
  KanbanSquare,
  Inbox,
  CalendarClock,
  CalendarCheck,
  Building2,
  FileText,
  Receipt,
  History,
  PhoneCall,
  Table2,
  Users,
  Workflow,
  ShieldAlert,
  ShieldCheck,
  Settings2,
} from "lucide-react";

/**
 * The logistics CRM's sidebar, with its groups built from the business's own tables.
 *
 * The template's nav was freight pages by name — inbound requests, in-process shipments,
 * space & containers. Here each group is filled from the build's app.json: the primary
 * table sits under Pipeline where inbound requests were, and every other table lands in
 * Operations with the icon of the template page it was cloned from.
 */
interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
  badge?: number;
}

const ROLE_ICON: Record<Role, React.ElementType> = {
  primary: Inbox,
  slots: CalendarClock,
  bookings: CalendarCheck,
  partners: Building2,
  quotes: FileText,
  lines: Receipt,
  events: History,
  calls: PhoneCall,
  other: Table2,
};

export default function Sidebar() {
  const { info, primary, version } = useApp();
  const m = info.manifest;
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api.approvals().then((a) => setPending(a.filter((x) => x.status === "pending").length)).catch(() => {});
  }, [version]);

  const groups: Array<{ title?: string; items: NavItem[] }> = [
    { items: [{ to: "/", label: "Overview", icon: LayoutDashboard }] },
    {
      title: "Pipeline",
      items: [
        { to: "/board", label: `${m.vertical.label} board`, icon: KanbanSquare },
        { to: `/e/${primary.name}`, label: primary.label, icon: Inbox },
      ],
    },
    {
      title: "Operations",
      items: m.entities
        .filter((e) => e.name !== primary.name)
        .map((e) => ({ to: `/e/${e.name}`, label: e.label, icon: ROLE_ICON[e.role] })),
    },
    {
      title: "Agents",
      items: [
        { to: "/agents", label: "Voice agents", icon: Users },
        { to: "/workflows", label: "Workflows", icon: Workflow },
      ],
    },
    {
      title: "Insights",
      items: [
        { to: "/approvals", label: "Approvals", icon: ShieldAlert, badge: pending },
        { to: "/audit", label: "Audit trail", icon: ShieldCheck },
      ],
    },
    { title: "Setup", items: [{ to: "/setup", label: "Business setup", icon: Settings2 }] },
  ];

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 border-r border-border bg-surface-1 flex flex-col">
      <div className="px-5 py-5">
        <CompanyBrand name={m.business.name} size="sm" descriptor={m.vertical.label} />
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((group, gi) => (
          <div key={gi} className="mb-4">
            {group.title && (
              <p className="px-2 mb-1 text-[11px] uppercase tracking-wide text-text-muted font-medium">{group.title}</p>
            )}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] mb-0.5 transition-colors ${
                    isActive ? "bg-surface-2 text-text-primary font-medium" : "text-text-secondary hover:bg-surface-2"
                  }`
                }
              >
                <item.icon size={16} />
                <span className="flex-1 truncate">{item.label}</span>
                {item.badge ? (
                  <span className="rounded-full bg-bg-warning text-text-warning text-[10px] font-semibold px-1.5 py-0.5">{item.badge}</span>
                ) : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="px-5 py-4 border-t border-border">
        <PoweredByAraxys />
        <p className="text-[10px] text-text-muted mt-1 truncate" title={m.template}>
          Built from {m.template.replace(/\s*\(.*\)$/, "")}
        </p>
      </div>
    </aside>
  );
}
