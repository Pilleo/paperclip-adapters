import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/paperclip-ci.yml", import.meta.url), "utf8");

test("the server-owned GitHub fixture covers every read-only command used by the orchestrator", () => {
  assert.match(workflow, /\*"pr list"\*\)/);
  assert.match(workflow, /\*"pr view"\*\)/);
  assert.match(workflow, /\*"pr checks"\*\)/);
});
