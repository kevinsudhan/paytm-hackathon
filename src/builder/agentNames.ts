/**
 * Every app's voice agents are its own people.
 *
 * Priya answers the logistics desk. A dental app built from that template gets agents
 * cloned from her — same voice setup, new job — but never her name: a caller who rings
 * both businesses must not hear the same person, and an agent name that already exists on
 * the SnapServe account belongs to whichever app (or person) made it first.
 *
 * Two places apply this:
 *   - fork.ts, when a draft is normalised: a template name, or a name used twice in one
 *     build, is replaced before anything is written;
 *   - deploy.ts, against the live account: any name another agent already has is replaced,
 *     and the build's prompt, greeting and files are rewritten to match, before the build's
 *     own agent is created.
 *
 * Names are drawn by the voice they will be spoken in — Priya's clones get a woman's name,
 * Arun's a man's — so the greeting and the voice agree.
 */
import { createHash } from "node:crypto";

const FEMALE = ["Meera", "Kavya", "Ananya", "Divya", "Nisha", "Lakshmi", "Sneha", "Revathi", "Aishwarya", "Deepa", "Pooja", "Swathi", "Janani", "Keerthana", "Harini", "Shalini"];
const MALE = ["Karthik", "Vikram", "Rohan", "Aditya", "Suresh", "Rahul", "Siddharth", "Varun", "Harish", "Ganesh", "Naveen", "Ravi", "Pranav", "Dinesh", "Manoj", "Senthil"];
const KNOWN: Record<string, "f" | "m"> = { priya: "f", arun: "m" };

export function genderOf(name: string): "f" | "m" {
  const n = baseName(name);
  if (KNOWN[n]) return KNOWN[n];
  if (MALE.some((x) => x.toLowerCase() === n)) return "m";
  return "f";
}

/** "Meera [dental-4796c5]" -> "meera": the person, without the build it belongs to. */
export function baseName(agentName: string): string {
  return agentName.replace(/\s*\[[^\]]+\]\s*$/, "").trim().toLowerCase();
}

/**
 * A name nobody in `taken` has, for an agent speaking in `voiceOf`'s voice. The same seed
 * always starts at the same place in the list, so a rebuilt draft keeps its names.
 */
export function pickName(voiceOf: string, taken: Set<string>, seed: string): string {
  const pool = genderOf(voiceOf) === "m" ? MALE : FEMALE;
  const start = parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 8), 16) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const n = pool[(start + i) % pool.length]!;
    if (!taken.has(n.toLowerCase())) return n;
  }
  for (let k = 2; ; k++) {
    const n = `${pool[start]} ${k}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** Replaces a name as a whole word, but never inside the business's own name. */
export function renameIn(text: string, from: string, to: string, businessName: string): string {
  const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return text.split(businessName).map((part) => part.replace(re, to)).join(businessName);
}
