import { useEffect, useState } from "react";

const API = "/api";

const defaultStrategy = {
  stop_loss_pct: 0.1,
  take_profit_pct: 0.5 as number | null,
  max_position_usd: 20,
  min_edge_divergence: 0.03,
  min_expected_edge_pct: 0.02,
  min_liquidity_24h: 500,
  max_slippage_pct: 0.05,
  max_positions: 4,
  max_hold_hours: 24,
  max_total_exposure_pct: 0.6,
  venue: "sim",
  signal_sources: ["simmer", "openclaw"],
  cooldown_minutes: 30,
  market_reentry_cooldown_minutes: 90,
  min_hours_to_resolution: 4,
  max_hours_to_resolution: 0,
  daily_loss_limit_usd: 25,
  cooloff_minutes_after_daily_stop: 120,
  market_tags: [] as string[],
  use_kelly_sizing: false,
  kelly_cap: 0.25,
  zero_fee_only: false,
  auto_regime: true,
  strategy_mode: "balanced",
  fallback_trade_usd: 1.0,
  auto_apply_evaluator: true,
  evaluator_interval_minutes: 30,
  evaluator_min_samples: 20,
  evaluator_min_policy_n: 8,
  evaluator_min_delta_score: 0.1,
  evaluator_min_confidence: 0.35,
  evaluator_return_clip: 3.0,
  evaluator_label_sources: null as string[] | null,
  evaluator_monitor_close_weight: 1.0,
  evaluator_time_split_validate: true,
  evaluator_time_split_train_fraction: 0.75,
  evaluator_min_holdout_rows: 12,
  evaluator_holdout_min_delta: 0.02,
  allow_relax_min_divergence: true,
  allow_zero_divergence_fallback_scan: true,
  allow_fallback_activity_trade: true,
  persist_auto_regime_to_disk: true,
  skill: "built-in",
  max_positions_per_market_type: 4,
  max_positions_per_theme_same_side: 3,
  loss_streak_pause_threshold: 4,
  loss_streak_pause_minutes: 45,
  preferred_resolution_hours_min: 8,
  preferred_resolution_hours_max: 96,
  ensemble_resolution_sweet_spot_bonus: 0.07,
  learning_effective_after: "",
};

interface AppConfig {
  openclaw_url: string;
  openclaw_hooks_path: string;
  openclaw_hooks_token: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
}

export function Settings() {
  const [strategy, setStrategy] = useState(defaultStrategy);
  const [config, setConfig] = useState<AppConfig>({
    openclaw_url: "",
    openclaw_hooks_path: "/hooks",
    openclaw_hooks_token: "",
    telegram_bot_token: "",
    telegram_chat_id: "",
  });
  const [apiKey, setApiKey] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentDesc, setAgentDesc] = useState("");
  const [registerResult, setRegisterResult] = useState<{
    api_key?: string;
    claim_url?: string;
    claim_code?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/strategy`).then((r) => r.json()).catch(() => ({})),
      fetch(`${API}/config`).then((r) => r.json()).catch(() => ({})),
    ]).then(([strategyData, configData]) => {
      setStrategy({ ...defaultStrategy, ...strategyData });
      setConfig((c) => ({ ...c, ...configData }));
    }).finally(() => setLoading(false));
  }, []);

  const saveStrategy = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/strategy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(strategy),
      });
    } finally {
      setSaving(false);
    }
  };

  const registerAgent = async () => {
    if (!agentName.trim()) return;
    setSaving(true);
    setRegisterResult(null);
    try {
      const r = await fetch(`${API}/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agentName.trim(), description: agentDesc.trim() }),
      });
      const data = await r.json();
      if (r.ok) setRegisterResult(data);
      else setRegisterResult({ api_key: `Error: ${data.error || r.status}` } as never);
    } catch (e) {
      setRegisterResult({ api_key: `Error: ${e}` } as never);
    } finally {
      setSaving(false);
    }
  };

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API}/config/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
    } finally {
      setSaving(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <h2 style={{ margin: 0 }}>Settings</h2>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>Strategy Tweaks</h3>
        {loading ? (
          <p>Loading...</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 400 }}>
            <label>
              Active skill
              <select
                value={strategy.skill ?? "built-in"}
                onChange={(e) => setStrategy({ ...strategy, skill: e.target.value })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              >
                <option value="built-in">Built-in (Rookie engine)</option>
                <option value="polymarket-ai-divergence">AI Divergence (Skills)</option>
                <option value="polymarket-weather-trader">Weather Trader (Skills)</option>
              </select>
            </label>
            <label>
              Stop-loss % (exit if P&L drops below)
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={strategy.stop_loss_pct}
                onChange={(e) => setStrategy({ ...strategy, stop_loss_pct: parseFloat(e.target.value) || 0.1 })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Take-profit % (optional)
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Off"
                value={strategy.take_profit_pct ?? ""}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    take_profit_pct: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max position ($)
              <input
                type="number"
                min="1"
                max="200"
                value={strategy.max_position_usd}
                onChange={(e) => setStrategy({ ...strategy, max_position_usd: parseFloat(e.target.value) || 20 })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Min edge divergence
              <input
                type="number"
                step="0.01"
                min="0"
                value={strategy.min_edge_divergence}
                onChange={(e) =>
                  setStrategy({ ...strategy, min_edge_divergence: parseFloat(e.target.value) || 0.03 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Min expected edge after fees/slippage
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={strategy.min_expected_edge_pct}
                onChange={(e) =>
                  setStrategy({ ...strategy, min_expected_edge_pct: parseFloat(e.target.value) || 0.02 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Min liquidity (24h volume)
              <input
                type="number"
                min="0"
                value={strategy.min_liquidity_24h}
                onChange={(e) =>
                  setStrategy({ ...strategy, min_liquidity_24h: parseFloat(e.target.value) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max slippage %
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={strategy.max_slippage_pct}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_slippage_pct: parseFloat(e.target.value) || 0.05 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max positions
              <input
                type="number"
                min="1"
                max="20"
                value={strategy.max_positions}
                onChange={(e) => setStrategy({ ...strategy, max_positions: parseInt(e.target.value, 10) || 4 })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max hold time (hours, 0 = off)
              <input
                type="number"
                min="0"
                max="720"
                step="1"
                value={strategy.max_hold_hours ?? 24}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_hold_hours: parseFloat(e.target.value) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max total exposure (% of balance)
              <input
                type="number"
                step="0.05"
                min="0.1"
                max="1"
                value={strategy.max_total_exposure_pct}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_total_exposure_pct: parseFloat(e.target.value) || 0.6 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Cooldown (minutes between trades)
              <input
                type="number"
                min="0"
                value={strategy.cooldown_minutes}
                onChange={(e) =>
                  setStrategy({ ...strategy, cooldown_minutes: parseInt(e.target.value, 10) || 30 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Market re-entry cooldown (minutes after close)
              <input
                type="number"
                min="0"
                value={strategy.market_reentry_cooldown_minutes ?? 90}
                onChange={(e) =>
                  setStrategy({ ...strategy, market_reentry_cooldown_minutes: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Min hours to resolution (skip markets resolving sooner)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.min_hours_to_resolution ?? 4}
                onChange={(e) =>
                  setStrategy({ ...strategy, min_hours_to_resolution: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max hours to resolution (0 = off; skip markets resolving later than this)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.max_hours_to_resolution ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_hours_to_resolution: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
              Autonomy: theme caps, loss-streak pause (new entries only), resolution sweet spot for ranking. Set caps to 0 to disable.
            </p>
            <label>
              Max open positions per theme (crypto/sports/…; 0 = off)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.max_positions_per_market_type ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_positions_per_market_type: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Max positions per theme + side (0 = off)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.max_positions_per_theme_same_side ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, max_positions_per_theme_same_side: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Loss streak → pause new buys (0 = off; consecutive losses)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.loss_streak_pause_threshold ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, loss_streak_pause_threshold: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Loss-streak pause duration (minutes)
              <input
                type="number"
                min="5"
                step="1"
                value={strategy.loss_streak_pause_minutes ?? 45}
                onChange={(e) =>
                  setStrategy({ ...strategy, loss_streak_pause_minutes: parseInt(e.target.value, 10) || 45 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Preferred resolution window — min hours (0 = no sweet spot)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.preferred_resolution_hours_min ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, preferred_resolution_hours_min: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Preferred resolution window — max hours (for ranking sweet spot)
              <input
                type="number"
                min="0"
                step="1"
                value={strategy.preferred_resolution_hours_max ?? 0}
                onChange={(e) =>
                  setStrategy({ ...strategy, preferred_resolution_hours_max: parseInt(e.target.value, 10) || 0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Ensemble bonus inside preferred window (e.g. 0.07)
              <input
                type="number"
                min="0"
                max="0.3"
                step="0.01"
                value={strategy.ensemble_resolution_sweet_spot_bonus ?? 0}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    ensemble_resolution_sweet_spot_bonus: parseFloat(e.target.value) || 0,
                  })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Daily loss limit ($) before pause
              <input
                type="number"
                min="1"
                value={strategy.daily_loss_limit_usd}
                onChange={(e) =>
                  setStrategy({ ...strategy, daily_loss_limit_usd: parseFloat(e.target.value) || 25 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Cool-off minutes after daily stop
              <input
                type="number"
                min="15"
                value={strategy.cooloff_minutes_after_daily_stop}
                onChange={(e) =>
                  setStrategy({ ...strategy, cooloff_minutes_after_daily_stop: parseInt(e.target.value, 10) || 120 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.auto_regime ?? true}
                onChange={(e) => setStrategy({ ...strategy, auto_regime: e.target.checked })}
              />
              Auto regime tuning (defensive/balanced/aggressive)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.persist_auto_regime_to_disk ?? true}
                onChange={(e) => setStrategy({ ...strategy, persist_auto_regime_to_disk: e.target.checked })}
              />
              Persist auto regime changes to strategy file (off = in-memory only, logged)
            </label>
            <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
              Profit focus: disable activity fallbacks below to avoid low-edge trades after idle periods.
            </p>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.allow_relax_min_divergence ?? true}
                onChange={(e) => setStrategy({ ...strategy, allow_relax_min_divergence: e.target.checked })}
              />
              Relax min divergence after long idle streak
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.allow_zero_divergence_fallback_scan ?? true}
                onChange={(e) => setStrategy({ ...strategy, allow_zero_divergence_fallback_scan: e.target.checked })}
              />
              Allow zero-divergence opportunity rescan when idle
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.allow_fallback_activity_trade ?? true}
                onChange={(e) => setStrategy({ ...strategy, allow_fallback_activity_trade: e.target.checked })}
              />
              Allow tiny fallback trade after 2h idle (top market)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.auto_apply_evaluator ?? true}
                onChange={(e) => setStrategy({ ...strategy, auto_apply_evaluator: e.target.checked })}
              />
              Auto-apply offline evaluator policy updates
            </label>
            <label>
              Learning effective after (ISO UTC, optional — drops older trades from evaluator, calibration, hourly)
              <input
                type="text"
                placeholder="2025-03-01T00:00:00Z"
                value={strategy.learning_effective_after ?? ""}
                onChange={(e) => setStrategy({ ...strategy, learning_effective_after: e.target.value.trim() })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem", fontFamily: "monospace" }}
              />
            </label>
            <label>
              Evaluator interval (minutes)
              <input
                type="number"
                min="5"
                value={strategy.evaluator_interval_minutes ?? 30}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_interval_minutes: parseInt(e.target.value, 10) || 30 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator minimum labeled samples
              <input
                type="number"
                min="5"
                value={strategy.evaluator_min_samples ?? 20}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_min_samples: parseInt(e.target.value, 10) || 20 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator minimum policy sample size
              <input
                type="number"
                min="3"
                value={strategy.evaluator_min_policy_n ?? 8}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_min_policy_n: parseInt(e.target.value, 10) || 8 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator minimum score improvement
              <input
                type="number"
                min="0"
                step="0.01"
                value={strategy.evaluator_min_delta_score ?? 0.1}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_min_delta_score: parseFloat(e.target.value) || 0.1 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator minimum confidence
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={strategy.evaluator_min_confidence ?? 0.35}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_min_confidence: parseFloat(e.target.value) || 0.35 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator return clip (x cost basis)
              <input
                type="number"
                min="0.5"
                max="10"
                step="0.5"
                value={strategy.evaluator_return_clip ?? 3.0}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_return_clip: parseFloat(e.target.value) || 3.0 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator label sources (comma-separated; empty = all). E.g. resolved-position,monitor-close
              <input
                type="text"
                placeholder="resolved-position"
                value={
                  Array.isArray(strategy.evaluator_label_sources)
                    ? strategy.evaluator_label_sources.join(",")
                    : ""
                }
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setStrategy({
                    ...strategy,
                    evaluator_label_sources:
                      v === "" ? null : v.split(",").map((s) => s.trim()).filter(Boolean),
                  });
                }}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator weight for monitor-close labels (vs 1.0 for resolved)
              <input
                type="number"
                min="0"
                max="3"
                step="0.1"
                value={strategy.evaluator_monitor_close_weight ?? 1.0}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    evaluator_monitor_close_weight: parseFloat(e.target.value) || 0,
                  })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.evaluator_time_split_validate ?? true}
                onChange={(e) => setStrategy({ ...strategy, evaluator_time_split_validate: e.target.checked })}
              />
              Evaluator holdout validation (blocks auto-apply if policy fails on recent slice)
            </label>
            <label>
              Evaluator train fraction (chronological; rest = holdout)
              <input
                type="number"
                min="0.55"
                max="0.9"
                step="0.05"
                value={strategy.evaluator_time_split_train_fraction ?? 0.75}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    evaluator_time_split_train_fraction: parseFloat(e.target.value) || 0.75,
                  })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator min holdout rows (time-split)
              <input
                type="number"
                min="5"
                max="200"
                value={strategy.evaluator_min_holdout_rows ?? 12}
                onChange={(e) =>
                  setStrategy({ ...strategy, evaluator_min_holdout_rows: parseInt(e.target.value, 10) || 12 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Evaluator holdout min score delta vs baseline on holdout
              <input
                type="number"
                min="0"
                max="0.5"
                step="0.01"
                value={strategy.evaluator_holdout_min_delta ?? 0.02}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    evaluator_holdout_min_delta: parseFloat(e.target.value) || 0.02,
                  })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label>
              Strategy mode (used when auto tuning is off)
              <select
                value={strategy.strategy_mode ?? "balanced"}
                onChange={(e) => setStrategy({ ...strategy, strategy_mode: e.target.value })}
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              >
                <option value="defensive">Defensive</option>
                <option value="balanced">Balanced</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </label>
            <label>
              Fallback trade amount ($) after 2h inactivity
              <input
                type="number"
                min="1"
                max="5"
                step="0.5"
                value={strategy.fallback_trade_usd}
                onChange={(e) =>
                  setStrategy({ ...strategy, fallback_trade_usd: parseFloat(e.target.value) || 1 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.use_kelly_sizing ?? false}
                onChange={(e) => setStrategy({ ...strategy, use_kelly_sizing: e.target.checked })}
              />
              Use Kelly sizing (AI-divergence style)
            </label>
            <label>
              Kelly cap (fraction of max bet, 0–1)
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={strategy.kelly_cap ?? 0.25}
                onChange={(e) =>
                  setStrategy({ ...strategy, kelly_cap: parseFloat(e.target.value) || 0.25 })
                }
                style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={strategy.zero_fee_only ?? false}
                onChange={(e) => setStrategy({ ...strategy, zero_fee_only: e.target.checked })}
              />
              Zero-fee markets only (skip markets with fees)
            </label>
            <button onClick={saveStrategy} disabled={saving} className="primary">
              {saving ? "Saving..." : "Save Strategy"}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>OpenClaw</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: "0 0 0.5rem 0" }}>
          For 10th-trade wake and strategy adjustment when win/loss &lt; 70/30. Use <strong>http://</strong> (not ws://) — webhooks use HTTP. Remote PC: http://192.168.x.x:18789
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 500 }}>
          <label>
            URL
            <input
              type="url"
              placeholder="http://192.168.1.21:18789"
              value={config.openclaw_url}
              onChange={(e) => setConfig({ ...config, openclaw_url: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label>
            Hooks path (default /hooks — change if your OpenClaw uses a different path)
            <input
              type="text"
              placeholder="/hooks"
              value={config.openclaw_hooks_path}
              onChange={(e) => setConfig({ ...config, openclaw_hooks_path: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label>
            Hooks token
            <input
              type="password"
              placeholder="Your OpenClaw webhook token"
              value={config.openclaw_hooks_token}
              onChange={(e) => setConfig({ ...config, openclaw_hooks_token: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <button onClick={saveConfig} disabled={saving}>
            Save OpenClaw
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>Telegram</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: "0 0 0.5rem 0" }}>
          Optional. For future report delivery. If missed, -1 point per game rule.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 500 }}>
          <label>
            Bot token
            <input
              type="password"
              placeholder="From @BotFather"
              value={config.telegram_bot_token}
              onChange={(e) => setConfig({ ...config, telegram_bot_token: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label>
            Chat ID
            <input
              type="text"
              placeholder="Your Telegram chat ID"
              value={config.telegram_chat_id}
              onChange={(e) => setConfig({ ...config, telegram_chat_id: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <button onClick={saveConfig} disabled={saving}>
            Save Telegram
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>Simmer API Key</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: "0 0 0.5rem 0" }}>
          Paste your API key from Simmer (or register a new agent below).
        </p>
        <div style={{ display: "flex", gap: "0.5rem", maxWidth: 500 }}>
          <input
            type="password"
            placeholder="sk_live_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={saveApiKey} disabled={saving}>
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>Telegram Bot Commands</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: "0 0 0.75rem 0" }}>
          Send these commands to your Rookie bot. Use <code>/help</code> to get inline buttons in Telegram.
        </p>
        <table style={{ fontSize: "0.82rem", borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            {([
              ["/report",    "Full advisor report — PnL, learning stats, problems"],
              ["/positions", "Open positions with P&L and time to resolution"],
              ["/pnl",       "Quick PnL + balance snapshot"],
              ["/status",    "Health check + paused/running state"],
              ["/pause",     "Halt new trading cycles (monitor still protects open positions)"],
              ["/resume",    "Restart trading cycles"],
              ["/cycle",     "Trigger one trading cycle immediately"],
              ["/align",     "Audit Simmer vs local state divergence"],
              ["/help",      "Command list + inline keyboard buttons"],
            ] as [string, string][]).map(([cmd, desc]) => (
              <tr key={cmd}>
                <td style={{ padding: "0.22rem 0.75rem 0.22rem 0", fontFamily: "monospace", whiteSpace: "nowrap", color: "var(--accent)" }}>{cmd}</td>
                <td style={{ color: "var(--text-muted)", padding: "0.22rem 0" }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 1rem 0" }}>Register New Agent (Simmer)</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: "0 0 0.5rem 0" }}>
          One-click registration. You will receive an API key (shown once) and a claim link.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 400 }}>
          <input
            placeholder="Agent name"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          />
          <input
            placeholder="Description (optional)"
            value={agentDesc}
            onChange={(e) => setAgentDesc(e.target.value)}
          />
          <button onClick={registerAgent} disabled={saving} className="primary">
            {saving ? "Registering..." : "Register New Agent"}
          </button>
        </div>
        {registerResult?.api_key && (
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              background: "var(--bg)",
              borderRadius: 6,
              border: "1px solid var(--border)",
            }}
          >
            <p style={{ color: "var(--red)", fontWeight: 600, margin: "0 0 0.5rem 0" }}>
              Save your API key now — it is shown only once!
            </p>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ wordBreak: "break-all" }}>{registerResult.api_key}</code>
              <button
                onClick={() => navigator.clipboard.writeText(registerResult.api_key!)}
              >
                Copy
              </button>
            </div>
            {registerResult.claim_url && (
              <p style={{ margin: "0.5rem 0 0 0" }}>
                <a href={registerResult.claim_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                  Claim link for human operator
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
