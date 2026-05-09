import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type UsageProviderKey = "codex" | "claude";

interface UsageData {
  window: number;
  weekly: number;
  windowLabel: string;
  windowResetsIn?: string;
  weeklyResetsIn?: string;
  windowResetProgress?: number;
  weeklyResetProgress?: number;
  error?: string;
}

interface UsageProvider {
  key: UsageProviderKey;
  label: string;
  oauthProviderId: string;
  statusUrl?: string;
  matches(provider: string, modelId: string): boolean;
  fetch(token: string, signal?: AbortSignal): Promise<UsageData>;
}

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const BACKGROUND_REFRESH_MS = 60_000;
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "pi-scream-cache.json");
const cache = new Map<UsageProviderKey, { data: UsageData; at: number }>();

let currentContext: ExtensionContext | undefined;
let usageInlineText: string | undefined;
let requestFooterRender: (() => void) | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let refreshInFlight = false;
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;

  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Record<UsageProviderKey, { data: UsageData; at: number }>>;
    for (const key of Object.keys(parsed) as UsageProviderKey[]) {
      const entry = parsed[key];
      if (entry?.data && typeof entry.at === "number") cache.set(key, entry);
    }
  } catch {
    // No persisted cache yet.
  }
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const data = Object.fromEntries(cache.entries());
    const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // Best-effort cache only.
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function secondsUntil(isoDate: string): number | undefined {
  const resetTime = new Date(isoDate).getTime();
  if (!Number.isFinite(resetTime)) return undefined;
  return Math.max(0, (resetTime - Date.now()) / 1000);
}

function formatResetsAt(isoDate: string): string | undefined {
  const seconds = secondsUntil(isoDate);
  return seconds === undefined ? undefined : formatDuration(seconds);
}

function resetProgress(remainingSeconds: number | undefined, totalSeconds: number): number | undefined {
  if (remainingSeconds === undefined || !Number.isFinite(remainingSeconds)) return undefined;
  const progress = ((totalSeconds - remainingSeconds) / totalSeconds) * 100;
  return Math.max(0, Math.min(100, progress));
}

function percent(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Number(n.toFixed(1))));
}

async function fetchJson(url: string, token: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const providers: UsageProvider[] = [
  {
    key: "codex",
    label: "Codex",
    oauthProviderId: "openai-codex",
    statusUrl: "https://chatgpt.com/codex/cloud/settings/analytics",
    matches: (provider) => provider === "openai-codex",
    async fetch(token, signal) {
      const data = await fetchJson("https://chatgpt.com/backend-api/wham/usage", token, signal);
      const primary = data?.rate_limit?.primary_window;
      const secondary = data?.rate_limit?.secondary_window;
      const primaryResetSeconds = typeof primary?.reset_after_seconds === "number" ? primary.reset_after_seconds : undefined;
      const secondaryResetSeconds = typeof secondary?.reset_after_seconds === "number" ? secondary.reset_after_seconds : undefined;
      return {
        windowLabel: "5h",
        window: percent(primary?.used_percent),
        weekly: percent(secondary?.used_percent),
        windowResetsIn: primaryResetSeconds !== undefined ? formatDuration(primaryResetSeconds) : undefined,
        weeklyResetsIn: secondaryResetSeconds !== undefined ? formatDuration(secondaryResetSeconds) : undefined,
        windowResetProgress: resetProgress(primaryResetSeconds, 5 * 60 * 60),
        weeklyResetProgress: resetProgress(secondaryResetSeconds, 7 * 24 * 60 * 60),
      };
    },
  },
  {
    key: "claude",
    label: "Claude",
    oauthProviderId: "anthropic",
    statusUrl: "https://status.anthropic.com/",
    matches: (provider) => provider === "anthropic",
    async fetch(token, signal) {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const fiveHourResetSeconds = data?.five_hour?.resets_at ? secondsUntil(data.five_hour.resets_at) : undefined;
      const weeklyResetSeconds = data?.seven_day?.resets_at ? secondsUntil(data.seven_day.resets_at) : undefined;
      return {
        windowLabel: "5h",
        window: percent(data?.five_hour?.utilization),
        weekly: percent(data?.seven_day?.utilization),
        windowResetsIn: fiveHourResetSeconds !== undefined ? formatDuration(fiveHourResetSeconds) : undefined,
        weeklyResetsIn: weeklyResetSeconds !== undefined ? formatDuration(weeklyResetSeconds) : undefined,
        windowResetProgress: resetProgress(fiveHourResetSeconds, 5 * 60 * 60),
        weeklyResetProgress: resetProgress(weeklyResetSeconds, 7 * 24 * 60 * 60),
      };
    },
  },
];

function detectUsageProvider(model: { provider: string; id: string } | undefined): UsageProvider | undefined {
  if (!model) return undefined;
  return providers.find((p) => p.matches(model.provider, model.id));
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function getUsage(provider: UsageProvider, force = false): Promise<UsageData> {
  loadCache();
  const cached = cache.get(provider.key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const token = await AuthStorage.create().getApiKey(provider.oauthProviderId);
    if (!token) {
      return { windowLabel: "5h", window: 0, weekly: 0, error: `missing ${provider.oauthProviderId} token; try /login` };
    }

    const data = await withTimeout((signal) => provider.fetch(token, signal));
    cache.set(provider.key, { data, at: Date.now() });
    saveCache();
    return data;
  } catch (err) {
    return {
      windowLabel: "5h",
      window: 0,
      weekly: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function compactUsage(provider: UsageProvider, data: UsageData): string {
  if (data.error) return `${provider.label}: ${data.error}`;
  return `Codex (plus) ${renderPlainBar(data.window, data.windowResetProgress)} ${data.window}%`;
}

function renderPlainBar(value: number, resetMarkerPercent?: number, width = 20): string {
  const safeValue = Math.max(0, Math.min(100, value));
  const filled = Math.round((safeValue / 100) * width);
  const markerIndex = resetMarkerPercent === undefined
    ? undefined
    : Math.max(0, Math.min(width - 1, Math.round((resetMarkerPercent / 100) * (width - 1))));

  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i === markerIndex) bar += "|";
    else bar += i < filled ? "#" : ".";
  }
  return bar;
}

function providerDisplayName(provider: UsageProvider): string {
  if (provider.key === "codex") return "Codex (plus) [premium]";
  return `${provider.label} [premium]`;
}

function usageText(provider: UsageProvider, data: UsageData): string {
  if (data.error) {
    return [
      "Usage Limits",
      "----------------------------------------",
      provider.label,
      `  error ${data.error}`,
      ...(provider.statusUrl ? ["", provider.statusUrl] : []),
    ].join("\n");
  }

  return [
    "Usage Limits",
    "----------------------------------------",
    providerDisplayName(provider),
    `  ${data.windowLabel.padEnd(5)} ${renderPlainBar(data.window, data.windowResetProgress)} ${data.window}%`,
    `  ${"week".padEnd(5)} ${renderPlainBar(data.weekly, data.weeklyResetProgress)} ${data.weekly}%`,
    ...(provider.statusUrl ? ["", provider.statusUrl] : []),
  ].join("\n");
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function installFooter(ctx: ExtensionContext) {
  currentContext = ctx;

  ctx.ui.setFooter((tui, theme, footerData) => {
    requestFooterRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const activeCtx = currentContext ?? ctx;
        let pwd = activeCtx.cwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;

        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        for (const entry of activeCtx.sessionManager.getEntries() as any[]) {
          if (entry.type === "message" && entry.message?.role === "assistant") {
            totalInput += entry.message.usage?.input ?? 0;
            totalOutput += entry.message.usage?.output ?? 0;
            totalCacheRead += entry.message.usage?.cacheRead ?? 0;
            totalCacheWrite += entry.message.usage?.cacheWrite ?? 0;
            totalCost += entry.message.usage?.cost?.total ?? 0;
          }
        }

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`in:${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`out:${formatTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

        const model = activeCtx.model;
        const usingSubscription = model ? activeCtx.modelRegistry.isUsingOAuth(model as any) : false;
        if (totalCost || usingSubscription) statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

        const contextUsage = activeCtx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";
        if (contextWindow) statsParts.push(`${contextPercent}%/${formatTokens(contextWindow)} (auto)`);

        let left = statsParts.join(" ");
        if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

        const modelName = model?.id || "no-model";
        let right = modelName;
        if (footerData.getAvailableProviderCount() > 1 && model) {
          right = `(${model.provider}) ${modelName}`;
        }

        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);
        let statsLine: string;
        if (leftWidth + 2 + rightWidth <= width) {
          statsLine = left + " ".repeat(width - leftWidth - rightWidth) + right;
        } else {
          const availableForRight = width - leftWidth - 2;
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(right, availableForRight, "");
            statsLine = left + " ".repeat(Math.max(2, width - leftWidth - visibleWidth(truncatedRight))) + truncatedRight;
          } else {
            statsLine = left;
          }
        }

        let pwdLine: string;
        if (usageInlineText) {
          const leftPwd = truncateToWidth(pwd, Math.max(0, width - visibleWidth(usageInlineText) - 2), "...");
          const padding = " ".repeat(Math.max(2, width - visibleWidth(leftPwd) - visibleWidth(usageInlineText)));
          pwdLine = leftPwd + padding + usageInlineText;
        } else {
          pwdLine = truncateToWidth(pwd, width, "...");
        }

        return [
          theme.fg("dim", pwdLine),
          theme.fg("dim", statsLine),
        ];
      },
    };
  });
}

async function updateStatus(ctx: ExtensionContext, provider: UsageProvider | undefined, force = false) {
  currentContext = ctx;
  if (!provider) {
    usageInlineText = undefined;
    requestFooterRender?.();
    return;
  }

  loadCache();
  const cached = cache.get(provider.key);
  if (cached) {
    usageInlineText = compactUsage(provider, cached.data);
    requestFooterRender?.();
    if (!force) return;
  }

  const data = await getUsage(provider, force);
  usageInlineText = compactUsage(provider, data);
  requestFooterRender?.();
}

async function refreshCurrentUsage(force = false) {
  const ctx = currentContext;
  if (!ctx || refreshInFlight) return;

  const provider = detectUsageProvider(ctx.model);
  if (!provider) {
    usageInlineText = undefined;
    requestFooterRender?.();
    return;
  }

  refreshInFlight = true;
  try {
    await updateStatus(ctx, provider, force);
  } finally {
    refreshInFlight = false;
  }
}

function startBackgroundRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    void refreshCurrentUsage(true);
  }, BACKGROUND_REFRESH_MS);
}

function stopBackgroundRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  loadCache();

  pi.on("model_select", async (event, ctx) => {
    await updateStatus(ctx, detectUsageProvider(event.model));
  });

  pi.on("session_start", async (_event, ctx) => {
    installFooter(ctx);
    startBackgroundRefresh();
    await updateStatus(ctx, detectUsageProvider(ctx.model));
  });

  pi.on("session_shutdown", async () => {
    stopBackgroundRefresh();
  });

  pi.registerCommand("usage", {
    description: "Show current provider usage (pi-scream)",
    handler: async (_args, ctx) => {
      const provider = detectUsageProvider(ctx.model);
      if (!provider) {
        const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
        ctx.ui.notify(`pi-scream: usage is not supported for current model (${current})`, "warning");
        return;
      }

      const data = await getUsage(provider);
      usageInlineText = compactUsage(provider, data);
      requestFooterRender?.();
      ctx.ui.notify(usageText(provider, data), data.error ? "error" : "info");
    },
  });
}
