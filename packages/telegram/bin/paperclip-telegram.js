#!/usr/bin/env node
import { PaperclipTelegramPlugin } from "../dist/index.js";

console.log("🚀 Starting Paperclip Telegram Operator Companion...");
const plugin = new PaperclipTelegramPlugin();

plugin.register().catch((err) => {
  console.error("Fatal Telegram plugin error:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\nStopping Telegram Companion...");
  await plugin.unregister();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await plugin.unregister();
  process.exit(0);
});
