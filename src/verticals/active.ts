/**
 * The vertical this deployment runs.
 *
 * The kernel imports this, never a vertical by name, so the twin and the policy gate do
 * not know which business they are serving. Switching verticals is this one line — and
 * the types follow it, so every state and action name in the engines is re-checked
 * against the new config at compile time.
 */
export { freight as ACTIVE } from "./freight.js";
