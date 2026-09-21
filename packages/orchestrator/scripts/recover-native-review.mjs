#!/usr/bin/env node
/**
 * Deprecated diagnostic entrypoint.
 *
 * Paperclip owns native-card dispatch. For a card that passed its dispatch
 * grace without any bound run, the adapter automatically issues one public,
 * interaction-bound, idempotent wake on that exact card. Card replacement is
 * reserved for a terminal bound reviewer run. Operators must never wake a
 * reviewer, write a comment, or create a card from this script.
 */
console.error(
  "Native-review mutation is disabled. Inspect the addressed card and bound runs; " +
  "the adapter will either observe it, recover one missing dispatch on the same card, " +
  "or report a visible protocol failure.",
);
process.exit(2);
