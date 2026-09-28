import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./workspace-node.sh", import.meta.url));

const output = execFileSync("/bin/bash", [script, "node", "-p", "process.version"], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  encoding: "utf8",
}).trim();

assert.match(output, /^v24\./, "the workspace launcher must not fall back to systemd's Node 22");
