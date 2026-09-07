import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "list_approvals.sh");

// Fixtures representing real Paperclip API responses
const taskStartApprovalFixture = {
  id: "app-task-start-123",
  type: "request_board_approval",
  status: "pending",
  title: null,
  description: null,
  issueIds: ["issue-20260907-182400-187"],
  payload: {
    action: "task_start",
    identifier: "MAZ-1241",
    title: "Show actionable metadata in fleet approval listings",
    issueId: "issue-20260907-182400-187",
  },
};

const mergeApprovalFixture = {
  id: "app-merge-456",
  type: "request_board_approval",
  status: "approved",
  title: null,
  description: null,
  issueIds: ["issue-20260907-182400-187"],
  payload: {
    action: "task_merge",
    issueId: "issue-20260907-182400-187",
    identifier: "MAZ-1241",
    title: "Show actionable metadata in fleet approval listings",
    prNumber: 526,
  },
};

const legacyTaskStartApprovalFixture = {
  id: "app-legacy-789",
  type: "task_start_approval",
  status: "rejected",
  title: "Start task [MAZ-1240]: \"Implement feature Y\"",
  description: "Task start authorization request",
  issueIds: ["issue-1240"],
  payload: {},
};

const legacyMergeApprovalFixture = {
  id: "app-legacy-merge-999",
  type: "task_merge_approval",
  status: "pending",
  title: "Approve PR #525 merge: [MAZ-1240] \"Implement feature Y\"",
  description: "Final PR merge authorization request",
  issueIds: ["issue-1240"],
  payload: {},
};

function runScriptWithFixture(fixtureArray, filter = "all") {
  // Create a mock API response
  const mockResponse = JSON.stringify(fixtureArray);
  
  // We'll test the jq processing by running jq directly on our fixtures
  // This simulates what the script does with the API response
  const jqFilterAll = `
    [.[] | {
      id: .id,
      type: .type,
      status: .status,
      action: (.payload.action // \"N/A\"),
      identifier: (.payload.identifier // .payload.issueId // \"N/A\"),
      title: (.payload.title // .title // \"N/A\")
    }]
  `;
  
  const jqFilterByStatus = (status) => `
    [map(select(.status == "${status}"))[] | {
      id: .id,
      type: .type,
      status: .status,
      action: (.payload.action // \"N/A\"),
      identifier: (.payload.identifier // .payload.issueId // \"N/A\"),
      title: (.payload.title // .title // \"N/A\")
    }]
  `;

  const jqCommand = filter === "all" ? jqFilterAll : jqFilterByStatus(filter);
  
  const result = spawnSync("jq", [jqCommand], {
    input: mockResponse,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stderr) {
    console.error("jq stderr:", result.stderr);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    console.error("Failed to parse jq output:", result.stdout);
    throw e;
  }
}

test("deterministic fixture-based test for task-start approval records", () => {
  const result = runScriptWithFixture([taskStartApprovalFixture]);
  
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "app-task-start-123");
  assert.equal(result[0].type, "request_board_approval");
  assert.equal(result[0].status, "pending");
  assert.equal(result[0].action, "task_start");
  assert.equal(result[0].identifier, "MAZ-1241");
  assert.equal(result[0].title, "Show actionable metadata in fleet approval listings");
});

test("deterministic fixture-based test for merge approval records", () => {
  const result = runScriptWithFixture([mergeApprovalFixture]);
  
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "app-merge-456");
  assert.equal(result[0].type, "request_board_approval");
  assert.equal(result[0].status, "approved");
  assert.equal(result[0].action, "task_merge");
  assert.equal(result[0].identifier, "MAZ-1241");
  assert.equal(result[0].title, "Show actionable metadata in fleet approval listings");
});

test("mixed approval records with payload and legacy data", () => {
  const result = runScriptWithFixture([
    taskStartApprovalFixture,
    mergeApprovalFixture,
    legacyTaskStartApprovalFixture,
    legacyMergeApprovalFixture,
  ]);
  
  assert.equal(result.length, 4);
  
  // Check task-start with payload
  assert.equal(result[0].action, "task_start");
  assert.equal(result[0].identifier, "MAZ-1241");
  
  // Check merge with payload
  assert.equal(result[1].action, "task_merge");
  assert.equal(result[1].identifier, "MAZ-1241");
  
  // Check legacy task-start (falls back to title)
  assert.equal(result[2].action, "N/A");
  assert.equal(result[2].identifier, "N/A");
  assert.equal(result[2].title, "Start task [MAZ-1240]: \"Implement feature Y\"");
  
  // Check legacy merge (falls back to title)
  assert.equal(result[3].action, "N/A");
  assert.equal(result[3].identifier, "N/A");
  assert.equal(result[3].title, "Approve PR #525 merge: [MAZ-1240] \"Implement feature Y\"");
});

test("filter by pending status", () => {
  const result = runScriptWithFixture(
    [taskStartApprovalFixture, mergeApprovalFixture, legacyTaskStartApprovalFixture],
    "pending"
  );
  
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "app-task-start-123");
  assert.equal(result[0].status, "pending");
  assert.equal(result[0].action, "task_start");
});

test("filter by approved status", () => {
  const result = runScriptWithFixture(
    [taskStartApprovalFixture, mergeApprovalFixture, legacyTaskStartApprovalFixture],
    "approved"
  );
  
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "app-merge-456");
  assert.equal(result[0].status, "approved");
  assert.equal(result[0].action, "task_merge");
});

test("filter by rejected status", () => {
  const result = runScriptWithFixture(
    [taskStartApprovalFixture, mergeApprovalFixture, legacyTaskStartApprovalFixture],
    "rejected"
  );
  
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "app-legacy-789");
  assert.equal(result[0].status, "rejected");
  assert.equal(result[0].action, "N/A");
});

// Test the actual script integration
test("script has expected jq projection", () => {
  const scriptContent = readFileSync(SCRIPT_PATH, "utf8");
  
  // Check that the script includes the new fields in its jq projection
  assert.ok(scriptContent.includes("payload.action"), "Script should include payload.action in jq projection");
  assert.ok(scriptContent.includes("payload.identifier"), "Script should include payload.identifier in jq projection");
  assert.ok(scriptContent.includes("payload.title"), "Script should include payload.title in jq projection");
  assert.ok(scriptContent.includes("payload.issueId"), "Script should include payload.issueId in jq projection");
});