/**
 * The cut-off sentinel.
 *
 * Slide 4 calls it "every deadline at once", which is the actual difference from a human
 * desk: a coordinator watches the shipment in front of them, and the one that quietly
 * expires is the one nobody had open. So this sweeps the whole book on a schedule and
 * does not care which shipment is interesting today.
 *
 * The sweep is the only thing allowed to expire a commitment. `reassessRisk` deliberately
 * does not — see the note in commitment.ts. One writer for expiry means a commitment
 * cannot be marked missed twice, which matters once escalation emails hang off it.
 *
 * Escalation is at-most-once per commitment. Without that, a sentinel on a 15-minute cron
 * turns one missed cut-off into 96 identical alerts a day and the desk stops reading them,
 * which is worse than not alerting at all.
 */

import {
  reassessRisk, isOverdue, escalate, blockedOn,
  type Commitment, formatIst,
} from "../domain/commitment.js";
import { openCommitments, putCommitment } from "./store.js";
import { assessAll } from "./riskEngine.js";

/** Commitments that have already produced an escalation, so we do not send a second. */
const escalated = new Set<string>();

export interface SweepResult {
  swept: number;
  raised: Array<{ id: string; what: string; customer: string; from: string; to: string }>;
  missed: Array<{ id: string; what: string; customer: string; deadline: string }>;
  escalations: Array<{ id: string; what: string; customer: string; to: string; why: string }>;
  at: string;
}

export interface SweepOptions {
  /** Who unresolved work is handed to. */
  escalateTo?: string;
  /** Hours before the deadline at which a still-blocked commitment gets a human. */
  escalateWhenBlockedWithinHours?: number;
  now?: Date;
}

/**
 * One pass over every open commitment.
 *
 * Returns what changed rather than sending anything itself. Notification is n8n's job —
 * keeping the sentinel pure means it can run in a test, in a cron, or twice by accident
 * without anyone being called twice.
 */
/**
 * A sweep that also asks memory.
 *
 * Kept separate from `sweep` rather than folded into it, because `sweep` is synchronous
 * and pure — it runs in a test, twice by accident, or on a cron without a network. Adding
 * an await inside it would make every one of those a graph traversal.
 *
 * So: the clock decides first, then memory gets a chance to raise what it knows about.
 * Memory being down leaves the clock's answer standing, which is the whole point of the
 * degradation rule in cognee.ts.
 */
export async function sweepWithMemory(opts: SweepOptions = {}): Promise<SweepResult & {
  memoryRaised: Array<{ id: string; customer: string; what: string; to: string; because: string }>;
}> {
  const result = sweep(opts);
  const memoryRaised: Array<{ id: string; customer: string; what: string; to: string; because: string }> = [];

  const open = openCommitments();
  if (open.length === 0) return { ...result, memoryRaised };

  const assessments = await assessAll(open);
  for (const c of open) {
    const a = assessments.get(c.id);
    if (!a || !a.memoryUsed || a.risk === c.risk) continue;
    putCommitment({ ...c, risk: a.risk, reason: a.reason, updatedAt: new Date().toISOString() });
    memoryRaised.push({
      id: c.id, customer: c.customer, what: c.what, to: a.risk,
      // The evidence, not just the verdict — see the rules at the top of riskEngine.ts.
      because: a.evidence[0] ?? a.reason,
    });
  }
  return { ...result, memoryRaised };
}

export function sweep(opts: SweepOptions = {}): SweepResult {
  const now = opts.now ?? new Date();
  const escalateTo = opts.escalateTo ?? "Aashish";
  const window = opts.escalateWhenBlockedWithinHours ?? 4;

  const result: SweepResult = { swept: 0, raised: [], missed: [], escalations: [], at: now.toISOString() };

  for (const before of openCommitments()) {
    result.swept++;
    let c: Commitment = reassessRisk(before, now);

    if (c.risk !== before.risk) {
      result.raised.push({
        id: c.id, what: c.what, customer: c.customer, from: before.risk, to: c.risk,
      });
    }

    if (isOverdue(c, now)) {
      c = { ...c, status: "missed", updatedAt: now.toISOString() };
      result.missed.push({
        id: c.id, what: c.what, customer: c.customer, deadline: formatIst(c.deadline),
      });
      if (!escalated.has(c.id)) {
        escalated.add(c.id);
        result.escalations.push({
          id: c.id, what: c.what, customer: c.customer, to: escalateTo,
          why: `deadline ${formatIst(c.deadline)} passed with the commitment open`,
        });
      }
    } else {
      // Not yet missed, but blocked with the clock running down. This is the case worth
      // catching — a human can still fix it, and only if they are told now.
      const hoursLeft = (new Date(c.deadline).getTime() - now.getTime()) / 3_600_000;
      const unmet = blockedOn(c);
      if (unmet.length > 0 && hoursLeft <= window && !escalated.has(c.id)) {
        const why = `${unmet.map((d) => d.label).join(" and ")} still outstanding with ${hoursLeft.toFixed(1)}h to ${formatIst(c.deadline)}`;
        c = escalate(c, escalateTo, why);
        escalated.add(c.id);
        result.escalations.push({ id: c.id, what: c.what, customer: c.customer, to: escalateTo, why });
      }
    }

    if (c !== before) putCommitment(c);
  }

  return result;
}

/**
 * The cut-off board: everything open, worst first.
 *
 * Sorted by deadline rather than by risk on purpose. Risk is a judgement the engine made;
 * the deadline is a fact the port will enforce, and when the two disagree the port wins.
 */
export function board(now = new Date()): Array<{
  id: string; customer: string; shipmentRef: string | null; what: string;
  deadline: string; hoursLeft: number; risk: string; status: string; blockedOn: string[];
}> {
  return openCommitments()
    .map((c) => ({
      id: c.id,
      customer: c.customer,
      shipmentRef: c.shipmentRef,
      what: c.what,
      deadline: formatIst(c.deadline),
      hoursLeft: Number(((new Date(c.deadline).getTime() - now.getTime()) / 3_600_000).toFixed(1)),
      risk: c.risk,
      status: c.status,
      blockedOn: blockedOn(c).map((d) => d.label),
    }))
    .sort((a, b) => a.hoursLeft - b.hoursLeft);
}

export function __reset(): void {
  escalated.clear();
}
