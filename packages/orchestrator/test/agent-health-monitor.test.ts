import { describe, it, expect } from "vitest";
import {
  evaluateAgentHealth,
  AgentHealthInput,
  formatAgentHealthAlertDigest,
} from "../src/core/agent-health-monitor.js";

describe("Agent Health Monitor & Formal Failure Tracker", () => {
  it("reports healthy when all agents are active/idle and chains are clean", () => {
    const agents: AgentHealthInput[] = [
      {
        id: "agent-1",
        name: "[Orchestrated] Jules Async Worker",
        status: "running",
        errorReason: null,
        pauseReason: null,
        orgChainHealth: { status: "healthy" },
      },
      {
        id: "agent-2",
        name: "Task Orchestrator",
        status: "idle",
        errorReason: null,
        pauseReason: null,
        orgChainHealth: { status: "healthy" },
      },
    ];

    const report = evaluateAgentHealth(agents);
    expect(report.isHealthy).toBe(true);
    expect(report.incidents).toHaveLength(0);
    expect(report.errorAgentsCount).toBe(0);
  });

  it("detects agent with status === 'error' or errorReason", () => {
    const agents: AgentHealthInput[] = [
      {
        id: "agent-1",
        name: "[Orchestrated] Jules Async Worker",
        status: "error",
        errorReason: "HTTP 429 Resource Exhausted: API quota exceeded for project",
        pauseReason: null,
        orgChainHealth: { status: "healthy" },
      },
    ];

    const report = evaluateAgentHealth(agents);
    expect(report.isHealthy).toBe(false);
    expect(report.incidents).toHaveLength(1);
    expect(report.incidents[0].agentName).toBe("[Orchestrated] Jules Async Worker");
    expect(report.incidents[0].severity).toBe("CRITICAL");
    expect(report.incidents[0].issue).toContain("HTTP 429 Resource Exhausted");
  });

  it("detects paused agent with error/crash reason", () => {
    const agents: AgentHealthInput[] = [
      {
        id: "agent-2",
        name: "[Orchestrated] Vibe Local Worker",
        status: "paused",
        errorReason: null,
        pauseReason: "Process crashed with SIGSEGV (exit code 139)",
        orgChainHealth: { status: "healthy" },
      },
    ];

    const report = evaluateAgentHealth(agents);
    expect(report.isHealthy).toBe(false);
    expect(report.incidents).toHaveLength(1);
    expect(report.incidents[0].severity).toBe("HIGH");
    expect(report.incidents[0].issue).toContain("Process crashed with SIGSEGV");
  });

  it("detects broken organizational escalation chain", () => {
    const agents: AgentHealthInput[] = [
      {
        id: "agent-3",
        name: "[Orchestrated] Code Reviewer",
        status: "idle",
        errorReason: null,
        pauseReason: null,
        orgChainHealth: {
          status: "broken",
          reason: "Escalation manager Chief of staff is paused and will not process tasks.",
        },
      },
    ];

    const report = evaluateAgentHealth(agents);
    expect(report.isHealthy).toBe(false);
    expect(report.incidents).toHaveLength(1);
    expect(report.incidents[0].severity).toBe("MEDIUM");
    expect(report.incidents[0].issue).toContain("Escalation manager Chief of staff is paused");
  });

  it("formats markdown incident digest for telemetry cards and Telegram", () => {
    const agents: AgentHealthInput[] = [
      {
        id: "agent-1",
        name: "[Orchestrated] Jules Async Worker",
        status: "error",
        errorReason: "HTTP 401 Unauthorized: Invalid API key",
        pauseReason: null,
      },
    ];

    const report = evaluateAgentHealth(agents);
    const digest = formatAgentHealthAlertDigest(report);
    expect(digest).toContain("🚨 **Agent Health Incident Alert**");
    expect(digest).toContain("[Orchestrated] Jules Async Worker");
    expect(digest).toContain("HTTP 401 Unauthorized");
  });
});
