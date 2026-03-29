import cron from "node-cron";
import fs from "fs/promises";
import path from "path";

import { buildAdvisorReport, buildOpenPositionsTelegramText } from "./advisor.js";
import { addLog } from "./logs.js";
import { acquireTelegramPollLock, fetchTelegramUpdates, sendTelegramMessage } from "./telegram.js";
import { broadcast } from "./websocket.js";
import { getPaused, setPaused } from "./engineStatus.js";

let telegramChatIdRuntime = (process.env.TELEGRAM_CHAT_ID || "").trim();

export function initScheduler(projectRoot: string) {
  const port = parseInt(process.env.PORT || "3001", 10);

  // Position monitor every 1 minute — always runs even when paused (protects open positions)
  cron.schedule("* * * * *", () => {
    runMonitor(port);
  });

  // Trading cycle every 15 minutes — skipped when engine is paused
  cron.schedule("*/15 * * * *", () => {
    if (getPaused().paused) {
      addLog("info", "Scheduler: cycle skipped (engine paused)");
      return;
    }
    runCycle(port);
  });

  // Fee + report every 2 hours
  cron.schedule("0 */2 * * *", () => {
    runReport(projectRoot, port);
  });

  // Daily advisory check
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

  // One-time test advisory after 5 minutes from startup
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
  addLog("info", "Scheduler: running 2h report (fee -1 point)");
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/engine/report`, { method: "POST" });
    const result = (await r.json().catch(() => ({}))) as {
      state?: { points?: number };
      report?: { points?: number };
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
    addLog(
      "success",
      `Scheduler: report saved (points: ${result?.state?.points ?? result?.report?.points ?? "—"})`
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
    addLog("info", "Telegram: TELEGRAM_DISABLE_POLL=1 — advisor command listener skipped");
    return;
  }

  const releasePollLock = acquireTelegramPollLock(projectRoot);
  if (!releasePollLock) {
    addLog(
      "warn",
      "Telegram: another Rookie backend holds the poll lock — not starting getUpdates. Set TELEGRAM_DISABLE_POLL=1 on this instance."
    );
    return;
  }

  addLog("info", "Telegram: advisor command listener started");
  void sendTelegramMessage(
    token,
    telegramChatIdRuntime || (process.env.TELEGRAM_CHAT_ID || "").trim(),
    "🤖 Rookie online.\nCommands: /report /positions /status /pause /resume /cycle /align /pnl /help",
    buildTelegramKeyboard()
  );

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
        // Handle callback_query (inline button tap) — answer it and route as command
        const cbq = u?.callback_query;
        if (cbq) {
          const cbChatId = String(cbq.message?.chat?.id ?? cbq.from?.id ?? "");
          const cbChatType = String(cbq.message?.chat?.type || "private");
          if (cbChatId && cbChatType === "private") {
            // Dismiss the loading spinner on the button
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cbq.id }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            if (telegramChatIdRuntime !== cbChatId) {
              telegramChatIdRuntime = cbChatId;
              addLog("info", `Telegram: bound runtime chat_id=${telegramChatIdRuntime} (callback)`);
            }
            // Re-inject as a synthetic message update by setting msg-like vars
            const cbText = String(cbq.data || "").trim().toLowerCase();
            if (cbText.startsWith("/")) {
              // Dispatch to command handler via a synthetic update
              u.message = { chat: { id: cbChatId, type: "private" }, text: cbText };
            }
          }
        }

        const msg = u?.message;
        if (!msg) continue;
        const incomingChatId = String(msg?.chat?.id ?? "");
        const chatType = String(msg?.chat?.type || "");
        if (!incomingChatId || chatType !== "private") continue;
        if (telegramChatIdRuntime !== incomingChatId) {
          telegramChatIdRuntime = incomingChatId;
          addLog("info", `Telegram: bound runtime chat_id=${telegramChatIdRuntime}`);
        }
        const text = String(msg?.text || "").trim().toLowerCase();
        if (!text.startsWith("/")) continue;

        // ── /report ──────────────────────────────────────────────
        if (text.startsWith("/report")) {
          await sendTelegramMessage(token, telegramChatIdRuntime, "Running advisor report…");
          try {
            const { text: reportText } = await buildAdvisorReport(port, projectRoot, "telegram:/report");
            await sendTelegramMessage(token, telegramChatIdRuntime, reportText);
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Report failed: ${String(e)}`);
          }

        // ── /positions ───────────────────────────────────────────
        } else if (text.startsWith("/position")) {
          try {
            const posText = await buildOpenPositionsTelegramText(port);
            await sendTelegramMessage(token, telegramChatIdRuntime, posText);
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Positions failed: ${String(e)}`);
          }

        // ── /status ──────────────────────────────────────────────
        } else if (text.startsWith("/status")) {
          try {
            const [health, paused] = await Promise.all([
              fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(8000) })
                .then((r) => r.json())
                .catch(() => ({})) as Promise<Record<string, any>>,
              fetch(`http://127.0.0.1:${port}/api/engine/paused`, { signal: AbortSignal.timeout(5000) })
                .then((r) => r.json())
                .catch(() => ({ paused: false })) as Promise<{ paused: boolean; reason?: string }>,
            ]);
            const pauseStr = paused.paused ? `⏸ PAUSED (${paused.reason ?? "manual"})` : "▶ running";
            const lines = [
              `Rookie status · ${pauseStr}`,
              `backend=${health?.backend?.status ?? "?"} simmer=${health?.simmer?.status ?? "?"} engine=${health?.engine?.status ?? "?"} openclaw=${health?.openclaw?.status ?? "?"}`,
            ];
            await sendTelegramMessage(token, telegramChatIdRuntime, lines.join("\n"));
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Status failed: ${String(e)}`);
          }

        // ── /pause ───────────────────────────────────────────────
        } else if (text.startsWith("/pause")) {
          try {
            await fetch(`http://127.0.0.1:${port}/api/engine/pause`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: "Telegram /pause command" }),
            });
            await sendTelegramMessage(token, telegramChatIdRuntime, "⏸ Engine paused. New trading cycles are halted. Monitor still protects open positions.\nUse /resume to restart.");
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Pause failed: ${String(e)}`);
          }

        // ── /resume ──────────────────────────────────────────────
        } else if (text.startsWith("/resume")) {
          try {
            await fetch(`http://127.0.0.1:${port}/api/engine/resume`, { method: "POST" });
            await sendTelegramMessage(token, telegramChatIdRuntime, "▶ Engine resumed. Trading cycles will run on next schedule.");
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Resume failed: ${String(e)}`);
          }

        // ── /cycle ───────────────────────────────────────────────
        } else if (text.startsWith("/cycle")) {
          const isPaused = getPaused().paused;
          if (isPaused) {
            await sendTelegramMessage(token, telegramChatIdRuntime, "Engine is paused. Use /resume first, or this command won't trigger a trade.");
          }
          await sendTelegramMessage(token, telegramChatIdRuntime, "Running cycle now…");
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/engine/cycle`, {
              method: "POST",
              signal: AbortSignal.timeout(60000),
            });
            const result = (await r.json().catch(() => ({}))) as { action?: string; reason?: string };
            await sendTelegramMessage(
              token,
              telegramChatIdRuntime,
              `Cycle done: ${result.action ?? "none"} — ${result.reason ?? "ok"}`
            );
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Cycle failed: ${String(e)}`);
          }

        // ── /align ───────────────────────────────────────────────
        } else if (text.startsWith("/align")) {
          await sendTelegramMessage(token, telegramChatIdRuntime, "Running alignment audit…");
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/audit/alignment`, {
              signal: AbortSignal.timeout(20000),
            });
            const data = (await r.json().catch(() => ({}))) as Record<string, any>;
            const lines = [
              `Alignment audit · ${data.aligned ? "✅ OK" : "⚠️ DIVERGED"}`,
              `Simmer: ${data.simmer?.active_positions ?? "?"} open · ${data.simmer?.wins ?? 0}W/${data.simmer?.losses ?? 0}L · PnL ${(data.simmer?.pnl ?? 0) >= 0 ? "+" : ""}${Number(data.simmer?.pnl ?? 0).toFixed(2)}`,
              `Local:  ${data.local?.buys ?? 0} buys · ${data.local?.wins ?? 0}W/${data.local?.losses ?? 0}L · ${data.local?.points ?? 0}pts`,
            ];
            if (data.divergences?.length) {
              lines.push("Issues:");
              for (const d of data.divergences) lines.push(`  · ${d}`);
            }
            await sendTelegramMessage(token, telegramChatIdRuntime, lines.join("\n"));
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `Align failed: ${String(e)}`);
          }

        // ── /pnl ─────────────────────────────────────────────────
        } else if (text.startsWith("/pnl")) {
          try {
            const [me, portfolio, gs] = await Promise.all([
              fetch(`http://127.0.0.1:${port}/api/simmer/agents/me`, { signal: AbortSignal.timeout(10000) })
                .then((r) => r.json())
                .catch(() => ({})) as Promise<Record<string, any>>,
              fetch(`http://127.0.0.1:${port}/api/simmer/portfolio`, { signal: AbortSignal.timeout(10000) })
                .then((r) => r.json())
                .catch(() => ({})) as Promise<Record<string, any>>,
              fetch(`http://127.0.0.1:${port}/api/game-state`, { signal: AbortSignal.timeout(5000) })
                .then((r) => r.json())
                .catch(() => ({})) as Promise<Record<string, any>>,
            ]);
            const portPnl = Number(portfolio?.sim_pnl ?? 0);
            const agentPnl = Number(me?.sim_pnl ?? me?.total_pnl ?? 0);
            const balance = Number(me?.balance ?? me?.sim_balance ?? 0);
            const lines = [
              `PnL snapshot`,
              `Portfolio: ${portPnl >= 0 ? "+" : ""}${portPnl.toFixed(2)} $SIM`,
              `Agent/me:  ${agentPnl >= 0 ? "+" : ""}${agentPnl.toFixed(2)} $SIM`,
              `Balance:   ${balance.toFixed(2)} $SIM`,
              `Game: ${gs?.points ?? 0}pts · ${gs?.wins ?? 0}W/${gs?.losses ?? 0}L`,
            ];
            await sendTelegramMessage(token, telegramChatIdRuntime, lines.join("\n"));
          } catch (e) {
            await sendTelegramMessage(token, telegramChatIdRuntime, `PnL failed: ${String(e)}`);
          }

        // ── /help ────────────────────────────────────────────────
        } else if (text.startsWith("/help")) {
          await sendTelegramMessage(
            token,
            telegramChatIdRuntime,
            [
              "Rookie commands:",
              "/report   — full advisor report",
              "/positions — open positions + PnL + time left",
              "/status   — health + paused state",
              "/pnl      — quick PnL / balance snapshot",
              "/pause    — halt new trading cycles",
              "/resume   — restart trading cycles",
              "/cycle    — trigger one cycle now",
              "/align    — audit Simmer vs local state",
              "/help     — this message + buttons",
            ].join("\n"),
            buildTelegramKeyboard()
          );
        }
      }
    } catch {
      // Keep polling.
    } finally {
      setTimeout(poll, hadUpdates ? 250 : 4000);
    }
  };
  void poll();
}

function buildTelegramKeyboard(): object {
  return {
    inline_keyboard: [
      [{ text: "📊 Report", callback_data: "/report" }, { text: "📍 Positions", callback_data: "/positions" }],
      [{ text: "💰 PnL", callback_data: "/pnl" }, { text: "🩺 Status", callback_data: "/status" }],
      [{ text: "⏸ Pause", callback_data: "/pause" }, { text: "▶ Resume", callback_data: "/resume" }],
      [{ text: "🔄 Cycle", callback_data: "/cycle" }, { text: "🔍 Align", callback_data: "/align" }],
    ],
  };
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
