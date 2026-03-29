import fs from "fs";
import path from "path";

/**
 * Only one process may poll Telegram getUpdates per bot token; two backends = duplicate /report, /status, etc.
 * Exclusive lock under data/; stale locks (dead PID) are removed on startup.
 */
export function acquireTelegramPollLock(projectRoot: string): (() => void) | null {
  const dir = path.join(projectRoot, "data");
  const lockPath = path.join(dir, ".telegram_poll.lock");

  const tryCreateLock = (): boolean => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, String(process.pid), 0, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };

  const tryRemoveStaleLock = (): boolean => {
    let raw = "";
    try {
      raw = fs.readFileSync(lockPath, "utf-8").trim();
    } catch {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return true;
    }
    const stalePid = parseInt(raw, 10);
    if (!Number.isFinite(stalePid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return true;
    }
    if (stalePid === process.pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return true;
    }
    let otherAlive = false;
    try {
      process.kill(stalePid, 0);
      otherAlive = true;
    } catch {
      otherAlive = false;
    }
    if (!otherAlive) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  };

  if (tryCreateLock()) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    };
    process.once("exit", release);
    return release;
  }

  if (tryRemoveStaleLock() && tryCreateLock()) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    };
    process.once("exit", release);
    return release;
  }

  return null;
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: object
): Promise<void> {
  if (!token || !chatId || !text) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // Telegram hard cap is 4096 chars; keep safe margin.
  const chunks = chunkText(text, 3800);
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
    };
    // Only attach reply_markup on the last chunk
    if (replyMarkup && i === chunks.length - 1) {
      body.reply_markup = replyMarkup;
    }
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }
}

export async function fetchTelegramUpdates(token: string, offset?: number): Promise<{ updates: any[]; nextOffset?: number }> {
  if (!token) return { updates: [] };
  const q = new URLSearchParams();
  q.set("timeout", "1");
  q.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
  if (typeof offset === "number") q.set("offset", String(offset));
  const url = `https://api.telegram.org/bot${token}/getUpdates?${q.toString()}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const data = (await r.json().catch(() => ({}))) as any;
  const updates = Array.isArray(data?.result) ? data.result : [];
  const lastUpdateId = updates.length ? updates[updates.length - 1].update_id : undefined;
  return { updates, nextOffset: typeof lastUpdateId === "number" ? lastUpdateId + 1 : offset };
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

