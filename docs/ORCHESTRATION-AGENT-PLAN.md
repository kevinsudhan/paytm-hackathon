# The business-ops orchestration agent

A plan, not a build. Nothing in this document is implemented yet.

---

## What is being proposed

Today SHIPMATE plus the v1 CRM is one system for one desk: Aashish Logistics, freight
forwarding, Chennai. The proposal is to turn that into a **generator** — a person describes
their business in their own words, and the output is a working system configured for it:
the agents, the workflows, the CRM screens, the approval thresholds.

The temptation is to make an agent that writes the software. That is the version that does
not work, and it is worth saying why before describing the version that does.

## Why "an agent that writes the software" fails

Every hard-won thing in this codebase came from a specific failure, and none of them are
things a model would write unprompted:

- `riskEngine.ts` scopes negation to the clause, because a 40-character window read
  *"had no recorded missed cut-offs, rolled bookings, disputed invoices"* as a real dispute
  and raised risk on the cleanest customer on the book.
- `margin.ts` strips commas and spaces before scanning a rendered quote for cost figures,
  and ignores anything under four digits, because the naive check passed a document that
  leaked the partner's buy rate.
- `rfq.ts` returns `null` rather than a guess when it cannot parse a reply, because the
  obvious regex matched nothing — a word boundary needs a word character, so the two
  commonest ways an Indian desk writes money both read as "no rate at all".
- `partners.ts` gates on role after scoring on tags, because the first live burst asked a
  road haulier and a customs broker for an ocean freight rate.
- `callIntake.ts` pins Opus, with the measurement in the comment, because a smaller model
  read the caller's own confused echo back as the rate.

A generator that regenerates these from a prompt will regenerate them *differently* each
time, and the differences are exactly where money leaks. So the generator does not write
engines.

## The shape that does work

```
  +----------------------------------------------------------+
  |  KERNEL - hand-written, versioned, tested, never generated|
  |  commitments . twin . policy gate . audit ledger .        |
  |  sentinel . memory . margin . RFQ . risk                  |
  +----------------------------------------------------------+
                            ^
                            |  reads
  +----------------------------------------------------------+
  |  CONFIG - one file per business, this is what is generated|
  |  entities . lifecycle . policy numbers . intake schema .  |
  |  partner roles . vocabulary                               |
  +----------------------------------------------------------+
                            ^
                            |  written by
  +----------------------------------------------------------+
  |  INTERVIEW AGENT + VERTICAL TEMPLATES                     |
  |  asks questions, starts from the nearest hand-built       |
  |  template, produces config for a human to approve         |
  +----------------------------------------------------------+
```

The engines stay fixed. Everything business-specific becomes a config file. The agent
writes the config.

## The config surface

Five sections. Nothing outside these is generated.

### `business`
Name, currency, timezone, working hours, the language the desk actually speaks. Freight
today: `en-IN`, `Asia/Kolkata`, IST rendering in every commitment deadline.

### `entities`
What the business tracks and what a record holds. Freight has enquiries, shipments,
partners, quotes. A dental practice has patients, appointments, treatment plans, labs. Same
storage, different names and fields.

### `lifecycle`
The state machine, and which actions are legal in which state. Freight's ten states are
`booking → docs → customs → container → gate_in → vessel → transit → arrival → delivery →
closed`, with rollover as the one deliberate backward edge. A recruitment desk would have
`sourced → screened → submitted → interview → offer → placed`. The *machine* is generic —
`can()` gating every action is the kernel — the *states* are config.

### `policy`
Which actions need a human, and above what number. Freight: ₹50,000 on payments, 10% on
discount, and five actions that are never autonomous regardless of amount (customs filing,
exemption requests, duty payment, billing disputes, delivery-order release).

Today these are constants in `policy.ts` with a comment saying they are constants *on
purpose*, so raising one is a commit someone signs off on. Moving them to config does not
change that: config for a new business is generated once and approved by a human, not
edited at deploy time.

### `intake`
The fields to pull from a call or a mail, with the phrasing the trade actually uses. This is
where the vocabulary lives — "CBM", "cut-off", "consignee" for freight; "chief complaint",
"referral" for a clinic. The extraction *engine* is fixed; the schema it fills is config.

## What gets generated from what

| Layer | Source | Generated? |
|---|---|---|
| Kernel engines | hand-written | never |
| Vertical template | hand-built, one per industry | never |
| Config file | interview + template | yes |
| CRM screens | config → existing components | yes, as layout |
| n8n workflows | template workflows + config substitution | yes, as parameters |
| Agent prompts | config vocabulary + fixed scaffold | yes, the middle section only |
| Capability modules | hand-written | never |

n8n substitution already works this way — `scripts/lib/substitute.mjs` bakes config into
workflow JSON at deploy time, because n8n Cloud restricts `$env` and licence-gates `$vars`.
The generator extends that mechanism rather than inventing one.

## The limit: capability modules

Some things are not config and will never be config.

The 3D container fit engine in v1 is real geometry — pieces, dimensions, orientation,
remaining floor. You cannot express "how do boxes pack into a 40ft container" as a schema.
Neither can you express customs tariff rules, or drug-interaction checks, or payroll tax.

So the honest boundary is: **the kernel is generic, the config is generated, and anything
requiring domain computation is a hand-written module the config merely switches on.**

A new vertical needs its capability modules built by a person. That is the cost, and
pretending otherwise is how this becomes a demo that only works on freight.

## The proof test

Before any of this is worth building, one question has to be answered in code:

> Can the current freight system be expressed as config, with zero freight-specific code
> left in the engines?

Right now the answer is no, and the gap is measurable. Counting freight vocabulary
(`cbm`, `container`, `cut-off`, `vessel`, `sailing`, `freight`, `consignee`, and so on)
across the non-test source:

```
src/domain/twin.ts            24   the ten states and their legal actions
src/engines/callIntake.ts     23   the extraction schema and its prompt
src/engines/emailIntake.ts    10
src/engines/rfq.ts            10
src/engines/partners.ts        7
src/memory/cognee.ts           6
src/adapters/crmV1.ts          3
src/engines/cutoffSentinel.ts  3
src/domain/commitment.ts       2
src/engines/riskEngine.ts      2
src/engines/store.ts           2
src/engines/margin.ts          1
src/domain/policy.ts           0   <- but see below
src/engines/auditLedger.ts     0
```

`policy.ts` scoring zero is the interesting one, and it shows the count is a floor rather
than a ceiling. It has no freight *words*, but `ALWAYS_APPROVED` is keyed on
`file_customs`, `pay_duty`, `release_do` — freight actions imported from `twin.ts`. The
vocabulary is generic; the data is not.

So the extraction is concentrated where you would expect: the state machine and the
extraction schema carry nearly half of it between them, and the ledger carries none. That
is the right shape — it means the parts that must not vary already do not.

**The test is not passed by making the count zero.** It is passed by making the count zero
*while every existing test still passes on the freight config*. `margin.test.ts`,
`partners.test.ts`, `rfq.test.ts`, `riskEngine.test.ts`, `twin.test.ts`,
`commitment.test.ts`, `emailIntake.test.ts` and `store.test.ts` are the contract. If
extraction breaks one of them, the abstraction is wrong and the right move is to stop, not
to edit the test.

## Sequence, if it is built

1. **Extract freight into config without changing behaviour.** Existing tests are the
   proof. One vertical, one config file, no generator yet.
2. **Build a second vertical by hand.** Not generated — hand-written config, by a person,
   for a genuinely different business. This is where the abstraction either holds or
   visibly fails. Doing it second rather than generating it second is the whole point.
3. **Only then, the interview agent.** It writes config that a human reads and approves
   before anything runs. Generated config is a draft, not a deployment.
4. **Capability modules stay a manual, scoped, per-vertical cost.** Say so in the pricing.

Steps 1 and 2 are the work. Step 3 is comparatively easy and is the part that demos well,
which is exactly why it should not come first.

## What this is not

It is not a system that reads a paragraph and produces a business. It is a fixed kernel
that has been beaten into shape by real failures, a small number of hand-built verticals,
and an agent that fills in the blanks between them — with a human reading the blanks before
they go live.
