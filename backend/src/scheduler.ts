import cron from "node-cron";
import fs from "fs/promises";
import path from "path";

import { buildAdvisorReport, buildOpenPositionsTelegramText } from "./advisor.js";
import { addLog } from "./logs.js";
import { acquireTelegramPollLock, fetchTelegramUpdates, sendTelegramMessage } from "./telegram.js";
import { broadcast } from "./websocket.js";

let telegramChatIdRuntime = (process.env.TELEGRAM_CHAT_ID || "").trim();

export function initScheduler(projectRoot: string) {
  const port = parseInt(process.env.PORT || "3001", 10);

  // Position monitor every 1 minute (stop-loss / take-profit / max-hold per strategy_config)
  cron.schedule("* * * * *", () => {
    runMonitor(port);
  });
  // Trading cycle every 15 minutes (find opportunities, execute trades)
  cron.schedule("*/15 * * * *", () => {
    runCycle(port);
  });
  // Fee + report every 2 hours, offset by +2 minutes to avoid colliding with 15-min cycle.
  cron.schedule("2 */2 * * *", () => {
    runReport(projectRoot, port);
  });

  // Daily advisory check (advice only, no strategy mutation)
  const advisorCron = process.env.ADVISOR_DAILY_CRON || "0 9 * * *";
  cron.schedule(advisorCron, () => {
    runAdvisor(projectRoot, port, "daily-cron");
  });

  // Nightly calibration refresh (set CALIBRATE_DAILY_CRON=off to skip)
  const calibrateCron = process.env.CALIBRATE_DAILY_CRON || "45 5 * * *";
  if (String(calibrateCron).trim().toLowerCase() !== "off") {
    cron.schedule(calibrateCron, () => {
      runCalibrateNightly(port);
    });
  }

  // One-time test advisory after 5 minutes from startup.
  setTimeout(() => {
    runAdvisor(projectRoot, port, "startup+5m-test");
  }, 5 * 60 * 1000);

  startTelegramAdvisorBot(projectRoot, port);
}

async function runMonitor(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/engine/monitor`, { method: "POST" });
    const result = (await r.json().catch(() => ({}))) as { closed?: number };
    if (result?.closed && result.closed > 0) {
      addLog("success", `Monitor: closed ${result.closed} position(s)`);
    }
  } catch {
    /* silent - monitor runs every minute */
  }
}

async function runCycle(port: number) {
  addLog("info", "Scheduler: running trading cycle");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/engine/cycle`, { method: "POST" });
    const result = (await r.json().catch(() => ({}))) as { action?: string; reason?: string };
    const action = result?.action ?? "none";
    addLog(
      action === "traded" ? "success" : "info",
      `Scheduler: cycle ${action} — ${result?.reason ?? (r.ok ? "ok" : String(r.status))}`
    );
  } catch (e) {
    addLog("error", `Scheduler: cycle failed — ${String(e)}`);
  }
}

async function runCalibrateNightly(port: number) {
  addLog("info", "Scheduler: running nightly calibration");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/learning/calibrate`, {
      method: "POST",
      signal: AbortSignal.timeout(120000),
    });
    const j = (await r.json().catch(() => ({}))) as { paired_samples?: number; ok?: boolean };
    if (r.ok) {
      addLog("success", `Scheduler: calibration ok (paired≈${j?.paired_samples ?? "—"})`);
    } else {
      addLog("warn", `Scheduler: calibration HTTP ${r.status}`);
    }
  } catch (e) {
    addLog("error", `Scheduler: calibration failed — ${String(e)}`);
  }
}

async function runReport(projectRoot: string, port: number) {
  addLog("info", "Scheduler: running periodic Simmer snapshot report");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/engine/report`, { method: "POST" });
    const result = (await r.json().catch(() => ({}))) as {
      report?: { fees_recent_sum?: number; positions_count?: number };
      error?: string;
    };
    if (!r.ok) {
      addLog("error", `Scheduler: report failed — HTTP ${r.status} ${result?.error ?? ""}`);
      broadcast({ type: "report", error: result?.error || `HTTP ${r.status}` });
      return;
    }
    const reportsDir = path.join(projectRoot, "data", "reports");
    await fs.mkdir(reportsDir, { recursive: true });
    const filename = `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await fs.writeFile(path.join(reportsDir, filename), JSON.stringify(result, null, 2));
    broadcast({ type: "report", payload: result });
    const fees = result?.report?.fees_recent_sum;
    const posN = result?.report?.positions_count;
    addLog(
      "success",
      `Scheduler: report saved (fees recent: ${fees ?? "—"}, positions: ${posN ?? "—"})`
    );
  } catch (e) {
    addLog("error", `Scheduler: report failed — ${String(e)}`);
    broadcast({ type: "report", error: String(e) });
  }
}

async function runAdvisor(projectRoot: string, port: number, trigger: string) {
  addLog("info", `Advisor: running (${trigger})`);
  try {
    const { text } = await buildAdvisorReport(port, projectRoot, trigger);
    addLog("success", `Advisor: completed (${trigger})`);
    await maybeSendTelegram(text);
  } catch (e) {
    addLog("error", `Advisor: failed (${trigger}) — ${String(e)}`);
  }
}

function startTelegramAdvisorBot(projectRoot: string, port: number) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    addLog("info", "Telegram: bot token not configured, advisory commands disabled");
    return;
  }

  const disablePoll = String(process.env.TELEGRAM_DISABLE_POLL || "").trim() === "1";
  if (disablePoll) {
    addLog("info", "Telegram: TELEGRAM_DISABLE_POLL=1 — advisor command listener skipped (cron/advisor still runs)");
    return;
  }

  const releasePollLock = acquireTelegramPollLock(projectRoot);
  if (!releasePollLock) {
    addLog(
      "warn",
      "Telegram: another Rookie backend holds data/.telegram_poll.lock — not starting getUpdates (prevents duplicate /report). Stop the other Node process or set TELEGRAM_DISABLE_POLL=1 on this one."
    );
    return;
  }

  addLog("info", "Telegram: advisor command listener started (exclusive poll lock acquired)");
  void maybeSendTelegram("Rookie advisor bot connected. Commands: /report, /positions, /status, /help");

  let offset: number | undefined;
  const poll = async () => {
    let hadUpdates = false;
    try {
      const { updates, nextOffset } = await fetchTelegramUpdates(token, offset);
      offset = nextOffset;
      hadUpdates = updates.length > 0;
      const seenIds = new Set<number>();
      for (const u of updates) {
        const uid = u?.update_id;
        if (typeof uid === "number") {
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
        }
        const msg = u?.message;
        if (!msg) continue;
        const incomingChatId = String(msg?.chat?.id ?? "");
        const chatType = String(msg?.chat?.type || "");
        if (!incomingChatId || chatType !== "private") continue;
        // Auto-bind runtime chat id to latest valid private incoming command source.
        if (telegramChatIdRuntime !== incomingChatId) {
          telegramChatIdRuntime = incomingChatId;
          addLog("info", `Telegram: bound runtime chat_id=${telegramChatIdRuntime}`);
        }
        const text = String(msg?.text || "").trim().toLowerCase();
        if (!text.startsWith("/")) continue;

        if (text.startsWith("/report")) {
          await sendTelegramMessage(token, telegramChatIdRuntime, "Running on-demand advisor report...");
          try {
            const { text: reportText } = await buildAdvisorReport(port, projectRoot, "telegram:/report");
            await sendTelegramMessage(token, telegramChatIdRuntime, reportText);
            addLog("success", "Telegram: /report served");
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Advisor report failed: ${String(e)}`);
          }
        } else if (text.startsWith("/status")) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) {
              await sendTelegramMessage(
                token,
                telegramChatIdRuntime,
                `Rookie status: /api/health failed (HTTP ${r.status}). Another app on port ${port}, or backend routes not loaded — run .\\start.ps1 once and close duplicate backend windows.`
              );
              continue;
            }
            const health = (await r.json().catch(() => ({}))) as Record<string, any>;
            const statusText =
              `Rookie status\n` +
              `backend=${health?.backend?.status || "?"}, simmer=${health?.simmer?.status || "?"}, engine=${health?.engine?.status || "?"}`;
            await sendTelegramMessage(token, telegramChatIdRuntime, statusText);
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Status check failed: ${String(e)}`);
          }
        } else if (text.startsWith("/positions") || text.startsWith("/posittions")) {
          try {
            const posText = await buildOpenPositionsTelegramText(port);
            await sendTelegramMessage(token, telegramChatIdRuntime, posText);
            addLog("success", "Telegram: /positions served");
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Positions failed: ${String(e)}`);
          }
        } else if (text.startsWith("/help")) {
          await sendTelegramMessage(
            token,
            telegramChatIdRuntime,
            "Commands:\n/report - full advisor report\n/positions - open positions, PnL, time to resolution (/posittions typo ok)\n/status - quick health\n/help - this message"
          );
        }
      }
    } catch {
      // Keep polling.
    } finally {
      // Short delay when there were updates (drain queue); longer when idle (avoid hammering API).
      setTimeout(poll, hadUpdates ? 250 : 4000);
    }
  };
  void poll();
}

async function maybeSendTelegram(text: string) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = telegramChatIdRuntime || (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return;
  try {
    await sendTelegramMessage(token, chatId, text);
  } catch (e) {
    addLog("error", `Telegram: send failed — ${String(e)}`);
  }
}
