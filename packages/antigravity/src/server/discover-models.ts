import { spawn } from "node:child_process";
import readline from "node:readline";
import { DEFAULT_AGY_SERVER_PATH } from "./config.js";
import type { AntigravityModel } from "../ui/models.js";

export async function fetchDynamicAntigravityModels(serverPath: string = DEFAULT_AGY_SERVER_PATH): Promise<AntigravityModel[]> {
  return new Promise((resolve) => {
    let resolved = false;
    const fallback: AntigravityModel[] = [
      { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
      { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
      { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
      { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)" },
      { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Medium)" },
      { id: "gemini-3.5-flash-extra-low", label: "Gemini 3.5 Flash (Low)" },
    ];

    try {
      const child = spawn(serverPath, ["--uid="], {
        stdio: ["pipe", "pipe", "ignore"],
      });

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill();
          resolve(fallback);
        }
      }, 4000);

      const rl = readline.createInterface({ input: child.stdout });

      const send = (msg: object) => {
        child.stdin.write(JSON.stringify(msg) + "\n");
      };

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "paperclip-model-discovery", version: "1.0" },
          capabilities: {},
        },
      });

      rl.on("line", (line) => {
        try {
          const res = JSON.parse(line.trim());
          if (res.id === 1 && res.result) {
            send({
              jsonrpc: "2.0",
              id: 2,
              method: "session/new",
              params: {
                cwd: process.cwd(),
                mcpServers: [],
              },
            });
          } else if (res.id === 2 && res.result) {
            const rawModels =
              res.result.models?.availableModels ||
              res.result.configOptions?.find((c: any) => c.id === "model")?.options ||
              [];

            if (Array.isArray(rawModels) && rawModels.length > 0) {
              const parsed: AntigravityModel[] = rawModels.map((m: any) => ({
                id: m.modelId || m.value,
                label: m.name || m.label || m.modelId || m.value,
              }));
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                child.kill();
                resolve(parsed);
              }
            }
          }
        } catch {
          // ignore parse errors on intermediate lines
        }
      });

      child.on("error", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(fallback);
        }
      });
    } catch {
      resolve(fallback);
    }
  });
}
