import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const forbidden = ["JULES_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN",
  "PAPERCLIP_API_KEY", "PAPERCLIP_TEST_API_URL", "PAPERCLIP_REAL_E2E", "DATABASE_URL"];

/** Own an isolated control plane for contracts; stop() preserves storage for a real restart. */
export function createDisposableHost({ root, command, args, port, environment = {}, readinessTimeoutMs = 30_000 }) {
  if (!path.isAbsolute(root) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) {
    throw new Error("Disposable host requires an absolute root, valid loopback port and bounded readiness timeout");
  }
  const home = path.join(root, "home");
  const url = `http://127.0.0.1:${port}`;
  let child = null;
  let childClosed = false;
  let disposed = false;
  const stop = async () => {
    if (!child) return;
    const running = child;
    if (running.exitCode === null && running.signalCode === null && running.pid) {
      try { process.kill(-running.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (!childClosed) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (running.pid) {
            try { process.kill(-running.pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") { reject(error); return; } }
          }
          const hardTimer = setTimeout(() => reject(new Error("Disposable host did not exit after SIGKILL")), 1500);
          running.once("close", () => { clearTimeout(hardTimer); resolve(); });
        }, 1500);
        running.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    // The parent may have exited on SIGTERM while its PostgreSQL/worker children
    // kept the process group alive. Reap the entire owned group before reuse.
    if (running.pid) {
      try { process.kill(-running.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    child = null;
  };
  return {
    home, url,
    get pid() { return child?.pid ?? null; },
    async start() {
      if (disposed || child) throw new Error("Disposable host is disposed or already started");
      await mkdir(home, { recursive: true });
      const env = { ...process.env, ...environment, HOME: home, PAPERCLIP_HOME: home,
        PAPERCLIP_INSTANCE_ID: `contract-${randomUUID()}`, PORT: String(port), HOST: "127.0.0.1" };
      for (const name of forbidden) delete env[name];
      const fd = openSync(path.join(root, "server.log"), "a", 0o600);
      try {
        child = spawn(command, args, { env, detached: true, stdio: ["ignore", fd, fd] });
      } finally {
        closeSync(fd);
      }
      const started = child;
      childClosed = false;
      started.once("close", () => { childClosed = true; });
      let launchError;
      started.once("error", (error) => { launchError = error; });
      const deadline = Date.now() + readinessTimeoutMs;
      try {
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          if (started.exitCode !== null || started.signalCode !== null) {
            throw new Error(`Disposable host exited before readiness (${started.exitCode ?? started.signalCode})`);
          }
          try {
            const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(300) });
            if (response.ok) return;
          } catch (error) {
            if (error.name !== "TimeoutError" && error.name !== "TypeError") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Disposable host readiness timeout after ${readinessTimeoutMs}ms`);
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
    async dispose() {
      await stop();
      disposed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}
