/**
 * The shape of a vertical — docs/ORCHESTRATION-AGENT-PLAN.md's "config surface".
 *
 * The kernel (the twin's state machine, the policy gate) is fixed code. A vertical is the
 * data it runs on: which states exist, what may happen in each, which actions always need
 * a human and above what number. Everything here is plain data on purpose — no functions,
 * no regexes — because the plan's end state is a config an interview agent drafts and a
 * person approves, and a function is not something a reviewer can approve by reading.
 *
 * `defineVertical` exists for its type checking, not its behaviour. The state names are
 * inferred from `lifecycle.order` and the action names from `actions`; every other place a
 * state or action is named is checked against those two lists rather than widening them.
 * So a typo in a `next` array, or a state granting an action nobody declared, is a compile
 * error in the config file instead of a state the machine can never reach.
 */

export type Approver = "desk" | "compliance" | "finance";

export interface StateSpec<S extends string, A extends string> {
  label: string;
  /** Documents or facts that must exist before an item can leave this state. */
  requirements: string[];
  /** What the system may do while an item sits here. */
  actions: A[];
  /** States reachable from here. Empty means terminal. */
  next: S[];
}

/**
 * A numeric brake: above (or at) a limit, a human decides.
 *
 * `measure` names which figure in the policy context is compared. The wording of the
 * refusal follows from `trigger`, so a config cannot make the gate say something the
 * comparison does not do.
 */
export interface ThresholdRule<A extends string> {
  actions: A[];
  measure: "amount" | "discountPct";
  limit: number;
  /** "atOrAbove" holds at the limit itself; "above" lets the limit through. */
  trigger: "atOrAbove" | "above";
  approver: Approver;
}

export interface VerticalConfig<S extends string = string, A extends string = string> {
  id: string;
  label: string;

  business: {
    name: string;
    /** ISO 4217, and the symbol the desk writes, because Intl renders ₹50,000.00. */
    currency: string;
    currencySymbol: string;
    /** For number formatting in anything a human reads. */
    locale: string;
    timezone: string;
  };

  lifecycle: {
    order: readonly S[];
    initial: NoInfer<S>;
    states: Record<NoInfer<S>, StateSpec<NoInfer<S>, NoInfer<A>>>;
  };

  /** Everything the system may ever do in this vertical. A state grants a subset. */
  actions: readonly A[];

  policy: {
    /** Never autonomous, whatever the amount. */
    alwaysApprove: Partial<Record<NoInfer<A>, { why: string; approver: Approver }>>;
    thresholds: ThresholdRule<NoInfer<A>>[];
  };

  /** What the builder needs to route a request here and read it against the live system. */
  builder: {
    /** Words that indicate this vertical in a request. */
    vocabulary: string[];
    /**
     * The business's word for a thing → the deployed table. Deployment facts, which is
     * why they are written down here rather than guessed by a model.
     */
    entityAliases: Record<string, string>;
    /**
     * Domain computation this vertical needs that cannot be config — the plan's limit.
     * Named so a plan can say it needs one, not so anything here can build one.
     */
    capabilityModules: string[];
    /**
     * What each deployed table is for, in one line. Only a template needs these: they are
     * how the builder tells a model what it may clone without sending it the code.
     */
    tableNotes?: Record<string, string>;
  };
}

export function defineVertical<const S extends string, const A extends string>(
  v: VerticalConfig<S, A>,
): VerticalConfig<S, A> {
  return v;
}
