/**
 * The kernel, running a built business.
 *
 * Every record on the primary table carries a twin — its lifecycle state, the
 * requirements of that state, and its history — driven by domain/machine.ts, the same
 * state machine the freight desk runs. Every action goes through the same two questions
 * the template asks, in the same order:
 *
 *   can()        is this action legal in the record's current state?
 *   decideFor()  may it happen now, or does a person approve it first?
 *
 * An action that needs a person is not refused and not performed: it is held, and the
 * hold is itself a ledger entry. Approving it later performs it and records who approved.
 * The ledger is append-only — the audit ledger's rule from the template: "this was done
 * and then undone" and "this never happened" are different facts.
 */
import { randomUUID } from "node:crypto";
import * as machine from "../domain/machine.js";
import { decideFor, type Verdict } from "../domain/policy.js";
import type { AppManifest, AppEntity } from "../builder/appManifest.js";
import { Store, StoreError, type Row } from "./store.js";

export interface LedgerEntry {
  id: string;
  at: string;
  by: string;
  kind: "created" | "updated" | "requirement" | "advanced" | "action" | "held" | "approved" | "rejected" | "refused" | "sample";
  entity: string;
  recordId: string | null;
  action?: string;
  from?: string;
  to?: string;
  verdict?: Verdict;
  summary: string;
}

export interface Approval {
  id: string;
  at: string;
  requestedBy: string;
  entity: string;
  recordId: string;
  action: string;
  context: { amount?: number; discountPct?: number; note?: string };
  why: string;
  approver: string;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
}

export type Twin = machine.MachineTwin & { recordId: string };

export class EngineError extends Error {}

export class Engine {
  readonly primary: AppEntity;
  readonly prefix: string;

  constructor(readonly app: AppManifest, readonly store: Store) {
    const p = app.entities.find((e) => e.name === app.primary.entity);
    if (!p) throw new Error(`app.json names ${app.primary.entity} as primary, which is not an entity`);
    this.primary = p;
    this.prefix = app.vertical.id.slice(0, 3).toUpperCase();
  }

  entity(name: string): AppEntity {
    const e = this.app.entities.find((x) => x.name === name);
    if (!e) throw new EngineError(`no entity ${name}`);
    return e;
  }

  // ------------------------------------------------------------------- ledger

  ledger(): LedgerEntry[] {
    return this.store.read<LedgerEntry[]>("_ledger", []);
  }

  /** Told about every entry after it is written — how a deployed app feeds its memory. */
  onRecord?: (entry: LedgerEntry) => void;

  private record(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
    const entry: LedgerEntry = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...e };
    this.store.write("_ledger", [...this.ledger(), entry]);
    try { this.onRecord?.(entry); } catch { /* a listener never undoes a write */ }
    return entry;
  }

  // -------------------------------------------------------------------- twins

  private twins(): Record<string, Twin> {
    return this.store.read<Record<string, Twin>>("_twins", {});
  }

  twin(recordId: string): Twin {
    const t = this.twins()[recordId];
    if (!t) throw new EngineError(`no lifecycle for ${recordId}`);
    return t;
  }

  private saveTwin(t: Twin): void {
    this.store.write("_twins", { ...this.twins(), [t.recordId]: t });
    // Mirror the state into the row's stage column, so the table reads the same as the twin.
    if (this.app.primary.stageColumn) {
      this.store.update(this.primary, t.recordId, { [this.app.primary.stageColumn]: t.state });
    }
  }

  // ------------------------------------------------------------------- records

  create(entityName: string, values: Row, by: string): Row {
    const entity = this.entity(entityName);
    const clean = { ...values };
    if (entity.name === this.primary.name && this.app.primary.stageColumn) delete clean[this.app.primary.stageColumn];
    const row = this.store.insert(entity, clean, this.prefix);
    const id = String(row[entity.key]);
    if (entity.name === this.primary.name) {
      this.saveTwin({ ...machine.startTwin(this.app.vertical), recordId: id });
    }
    this.record({ by, kind: "created", entity: entity.name, recordId: id, summary: `${entity.label.replace(/s$/, "")} ${id} created` });
    return this.store.get(entity, id)!;
  }

  update(entityName: string, id: string, values: Row, by: string): Row {
    const entity = this.entity(entityName);
    const clean = { ...values };
    // The stage only moves through advance(): a stage edited as a field skips the gate.
    if (entity.name === this.primary.name && this.app.primary.stageColumn && this.app.primary.stageColumn in clean) {
      throw new EngineError(`the stage moves through the lifecycle, not as a field — use "Move to"`);
    }
    const row = this.store.update(entity, id, clean);
    const fields = Object.keys(clean);
    this.record({ by, kind: "updated", entity: entity.name, recordId: id, summary: `${fields.join(", ")} updated` });
    return row;
  }

  // ------------------------------------------------------------------ lifecycle

  /** What the record may do now: legal actions with their policy verdicts, and where it can go. */
  options(recordId: string) {
    const t = this.twin(recordId);
    const v = this.app.vertical;
    const st = v.lifecycle.states[t.state];
    return {
      state: t.state,
      label: st.label,
      readiness: machine.readiness(t),
      requirements: t.requirements,
      unmet: machine.unmetRequirements(t),
      next: st.next.map((s) => ({ state: s, label: v.lifecycle.states[s].label })),
      actions: machine.legalActions(v, t.state).map((a) => ({ action: a, verdict: decideFor(v, a, {}) })),
      history: t.history,
      pendingApprovals: this.approvals().filter((a) => a.recordId === recordId && a.status === "pending"),
    };
  }

  setRequirement(recordId: string, requirement: string, met: boolean, by: string): Twin {
    const t = machine.setRequirement(this.twin(recordId), requirement, met);
    this.saveTwin(t);
    this.record({ by, kind: "requirement", entity: this.primary.name, recordId, summary: `${met ? "met" : "reopened"}: ${requirement}` });
    return t;
  }

  advance(recordId: string, to: string, why: string, force: boolean, by: string): Twin {
    const before = this.twin(recordId);
    let t: Twin;
    try {
      t = machine.advance(this.app.vertical, before, to, why || `moved by ${by}`, { force });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.record({ by, kind: "refused", entity: this.primary.name, recordId, from: before.state, to, summary: reason });
      throw new EngineError(reason);
    }
    this.saveTwin(t);
    this.record({
      by,
      kind: "advanced",
      entity: this.primary.name,
      recordId,
      from: before.state,
      to,
      summary: `${before.state} → ${to}${force ? ` (forced past: ${machine.unmetRequirements(before).join(", ")})` : ""}`,
    });
    return t;
  }

  /**
   * Takes an action on a record — the gate, in the template's order. Returns what
   * happened: performed, held for a person, or refused as illegal in this state.
   */
  act(recordId: string, action: string, ctx: Approval["context"], by: string): { outcome: "performed" | "held" | "refused"; entry: LedgerEntry; approval?: Approval } {
    const t = this.twin(recordId);
    const v = this.app.vertical;
    const legal = machine.can(v, t.state, action);
    if (!legal.ok) {
      const entry = this.record({ by, kind: "refused", entity: this.primary.name, recordId, action, summary: legal.reason });
      return { outcome: "refused", entry };
    }
    const verdict = decideFor(v, action, { amountInr: ctx.amount, discountPct: ctx.discountPct });
    if (verdict.autonomy === "approve") {
      const approval: Approval = {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        requestedBy: by,
        entity: this.primary.name,
        recordId,
        action,
        context: ctx,
        why: verdict.why,
        approver: verdict.approver,
        status: "pending",
      };
      this.store.write("_approvals", [...this.approvals(), approval]);
      const entry = this.record({ by, kind: "held", entity: this.primary.name, recordId, action, verdict, summary: `${human(action)} held for ${verdict.approver} — ${verdict.why}` });
      return { outcome: "held", entry, approval };
    }
    const entry = this.record({ by, kind: "action", entity: this.primary.name, recordId, action, verdict, summary: `${human(action)}${ctx.note ? ` — ${ctx.note}` : ""}` });
    return { outcome: "performed", entry };
  }

  approvals(): Approval[] {
    return this.store.read<Approval[]>("_approvals", []);
  }

  /**
   * Decides a held action. Approving re-checks legality first: a record that moved on while
   * the approval sat in the queue may no longer allow the action, and approving it anyway
   * would perform something the lifecycle forbids.
   */
  decideApproval(id: string, approve: boolean, by: string): Approval {
    const all = this.approvals();
    const i = all.findIndex((a) => a.id === id);
    if (i < 0) throw new EngineError(`no approval ${id}`);
    const a = all[i];
    if (a.status !== "pending") throw new EngineError(`approval ${id} was already ${a.status}`);
    if (a.requestedBy === by && approve) throw new EngineError("the person who asked for an action cannot also approve it");

    if (approve) {
      const legal = machine.can(this.app.vertical, this.twin(a.recordId).state, a.action);
      if (!legal.ok) throw new EngineError(`cannot approve: ${legal.reason} — the record has moved on since this was held`);
    }
    const decided: Approval = { ...a, status: approve ? "approved" : "rejected", decidedBy: by, decidedAt: new Date().toISOString() };
    const next = [...all];
    next[i] = decided;
    this.store.write("_approvals", next);
    this.record({
      by,
      kind: approve ? "approved" : "rejected",
      entity: a.entity,
      recordId: a.recordId,
      action: a.action,
      summary: `${human(a.action)} ${approve ? "approved and performed" : "rejected"} (asked by ${a.requestedBy})`,
    });
    return decided;
  }

  // ------------------------------------------------------------------ sample data

  /** Places a record in a given state, for sample data only — recorded as such. */
  placeSample(recordId: string, state: string): void {
    const t: Twin = { ...machine.startTwin(this.app.vertical, state), recordId };
    t.history = [{ from: null, to: state, at: t.updatedAt, why: "sample data" }];
    this.saveTwin(t);
  }

  note(summary: string, by: string): void {
    this.record({ by, kind: "sample", entity: this.primary.name, recordId: null, summary });
  }
}

const human = (a: string) => a.replace(/_/g, " ");

export { StoreError };
