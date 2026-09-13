import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runTest() {
  // Read the workflow file
  const workflowContent = fs.readFileSync('.github/workflows/paperclip-ci.yml', 'utf-8');

  // Extract the fixture
  const startMarker = "cat >\"${RUNNER_TEMP}/paperclip-e2e-bin/gh\" <<'EOF'";
  const endMarker = 'EOF';

  const startIndex = workflowContent.indexOf(startMarker);
  if (startIndex === -1) throw new Error("Could not find start marker in workflow file");

  const scriptStartIndex = startIndex + startMarker.length + 1; // +1 for newline
  const endIndex = workflowContent.indexOf(endMarker, scriptStartIndex);
  if (endIndex === -1) throw new Error("Could not find end marker in workflow file");

  const fixtureScript = workflowContent.substring(scriptStartIndex, endIndex);

  // Write to a temporary file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-fixture-test-'));
  const ghPath = path.join(tmpDir, 'gh');
  fs.writeFileSync(ghPath, fixtureScript);
  fs.chmodSync(ghPath, 0o755);

  const tests = [
    {
      name: "Exact match: pr list",
      args: ["pr", "list", "--repo", "pilleo/paperclip-adapters", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files"],
      shouldSucceed: true,
      expectedStdout: '[{"number":991,"title":"canary","state":"OPEN","headRefName":"canary","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergedAt":null,"url":"https://github.com/pilleo/paperclip-adapters/pull/991","files":["canary.txt"]}]\n'
    },
    {
      name: "Exact match: pr checks",
      args: ["pr", "checks", "991", "--json", "state,bucket,name"],
      shouldSucceed: true,
      expectedStdout: '[{"state":"SUCCESS","bucket":"pass","name":"canary"}]\n'
    },
    {
      name: "Fail: extra argument",
      args: ["pr", "list", "--repo", "pilleo/paperclip-adapters", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files", "--extra-arg"],
      shouldSucceed: false
    },
    {
      name: "Fail: wrong repo",
      args: ["pr", "list", "--repo", "wrong/repo", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files"],
      shouldSucceed: false
    },
    {
      name: "Fail: missing argument",
      args: ["pr", "list", "--repo", "pilleo/paperclip-adapters", "--state", "all", "--limit", "50", "--json"],
      shouldSucceed: false
    },
    {
      name: "Fail: mutated command (merge)",
      args: ["pr", "merge", "991"],
      shouldSucceed: false
    },
    {
      name: "Fail: missing pr view command",
      args: ["pr", "view", "991"],
      shouldSucceed: false
    },
    {
      name: "Fail: boundary test (combined args)",
      args: ["pr list", "--repo", "pilleo/paperclip-adapters", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files"],
      shouldSucceed: false
    }
  ];

  let failedTests = 0;

  for (const test of tests) {
    try {
      const { stdout } = await execFileAsync(ghPath, test.args);
      if (test.shouldSucceed) {
        if (stdout !== test.expectedStdout) {
          console.error(`❌ Test failed: ${test.name}\nExpected stdout:\n${test.expectedStdout}\nGot:\n${stdout}`);
          failedTests++;
        } else {
          console.log(`✅ Test passed: ${test.name}`);
        }
      } else {
        console.error(`❌ Test failed: ${test.name} - Expected failure, but it succeeded`);
        failedTests++;
      }
    } catch (error) {
      if (!test.shouldSucceed) {
        console.log(`✅ Test passed: ${test.name} (failed as expected)`);
      } else {
        console.error(`❌ Test failed: ${test.name} - Expected success, but it failed`);
        console.error(error);
        failedTests++;
      }
    }
  }

  // Cleanup
  fs.unlinkSync(ghPath);
  fs.rmdirSync(tmpDir);

  if (failedTests > 0) {
    console.error(`\n${failedTests} test(s) failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll tests passed.`);
  }
}

runTest().catch(console.error);
