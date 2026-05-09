import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type UsageProviderKey = "codex" | "claude" | "github-copilot";

interface UsageData {
  window: number;
  weekly: number;
  windowLabel: string;
  weeklyLabel?: string;
  windowDetail?: string;
  weeklyDetail?: string;
  windowResetsIn?: string;
  weeklyResetsIn?: string;
  windowResetProgress?: number;
  weeklyResetProgress?: number;
  planLabel?: string;
  refreshedAt?: number;
  debugLines?: string[];
  error?: string;
}

interface UsageProvider {
  key: UsageProviderKey;
  label: string;
  oauthProviderId: string;
  statusUrl?: string;
  matches(provider: string, modelId: string): boolean;
  getToken?(auth: AuthStorage): Promise<string | undefined>;
  fetch(token: string, signal?: AbortSignal): Promise<UsageData>;
}

interface CopilotQuotaSnapshot {
  entitlement?: number;
  overage_count?: number;
  percent_remaining?: number;
  quota_remaining?: number;
  remaining?: number;
  unlimited?: boolean;
  timestamp_utc?: string;
}

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const BACKGROUND_REFRESH_MS = 60_000;
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "pi-scream-cache.json");
const cache = new Map<UsageProviderKey, { data: UsageData; at: number }>();

let currentContext: ExtensionContext | undefined;
let selectedModel: ExtensionContext["model"] | undefined;
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

function formatRefreshTime(timestamp: number | undefined): string | undefined {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  const ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return `${formatTime(timestamp)} (${formatDuration(ageSeconds)} ago)`;
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

function usedPercentFromRemaining(value: unknown): number {
  const remaining = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(remaining)) return 0;
  return percent(100 - remaining);
}

function quotaUsedPercent(snapshot: CopilotQuotaSnapshot | undefined): number {
  if (!snapshot || snapshot.unlimited) return 0;
  if (typeof snapshot.percent_remaining === "number") return usedPercentFromRemaining(snapshot.percent_remaining);

  const remaining = typeof snapshot.remaining === "number" ? snapshot.remaining : snapshot.quota_remaining;
  if (typeof remaining === "number" && typeof snapshot.entitlement === "number" && snapshot.entitlement > 0) {
    return percent(((snapshot.entitlement - remaining) / snapshot.entitlement) * 100);
  }

  return 0;
}

function quotaDetail(snapshot: CopilotQuotaSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.unlimited) return "unlimited";

  const remaining = typeof snapshot.remaining === "number" ? snapshot.remaining : snapshot.quota_remaining;
  const parts: string[] = [];
  if (typeof remaining === "number" && typeof snapshot.entitlement === "number") parts.push(`${snapshot.entitlement - remaining}/${snapshot.entitlement}`);
  else if (typeof remaining === "number") parts.push(`${remaining} used`);
  if (typeof snapshot.overage_count === "number" && snapshot.overage_count > 0) parts.push(`${snapshot.overage_count} overage`);
  return parts.length ? parts.join(", ") : undefined;
}

function resetProgressFromDate(isoDate: string | undefined, totalSeconds: number): number | undefined {
  if (!isoDate) return undefined;
  return resetProgress(secondsUntil(isoDate), totalSeconds);
}

function getGitHubApiBaseFromCopilotCredential(auth: AuthStorage): string {
  const credential = auth.get("github-copilot") as { enterpriseUrl?: string } | undefined;
  const rawDomain = credential?.enterpriseUrl?.trim() || "github.com";
  let domain = rawDomain;
  try {
    domain = rawDomain.includes("://") ? new URL(rawDomain).hostname : new URL(`https://${rawDomain}`).hostname;
  } catch {
    domain = rawDomain;
  }
  return `https://api.${domain}`;
}

async function getGitHubCopilotRefreshToken(auth: AuthStorage): Promise<string | undefined> {
  await auth.getApiKey("github-copilot");
  const credential = auth.get("github-copilot") as { refresh?: string } | undefined;
  return credential?.refresh;
}

function normalizePlanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase()
    .replace(/^claude[_ -]?/, "")
    .replace(/^anthropic[_ -]?/, "")
    .replace(/^individual[_ -]?/, "")
    .replace(/^plan[_ -]?/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bpro plus\b/g, "pro+")
    .trim();
  return normalized || undefined;
}

function extractCopilotPlanLabel(data: any, premium: CopilotQuotaSnapshot | undefined): string | undefined {
  const labels = [data?.copilot_plan, data?.access_type_sku]
    .map(normalizePlanLabel)
    .filter((label): label is string => Boolean(label));

  const explicitProPlus = labels.find((label) => label === "pro+" || label.includes("pro+"));
  if (explicitProPlus) return explicitProPlus;

  const first = labels[0];
  if (first === "pro" && typeof premium?.entitlement === "number" && premium.entitlement >= 1500) return "pro+";
  return first;
}

function extractPlanLabel(data: any): string | undefined {
  const candidates = [
    data?.subscription?.plan,
    data?.subscription?.tier,
    data?.plan,
    data?.tier,
    data?.account?.plan,
    data?.account?.tier,
    data?.organization?.plan,
    data?.organization?.tier,
    data?.billing?.plan,
  ];
  for (const candidate of candidates) {
    const label = normalizePlanLabel(candidate);
    if (label) return label;
  }
  return undefined;
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
    statusUrl: "https://claude.ai/settings/usage",
    matches: (provider) => provider === "anthropic" || provider === "claude",
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
        planLabel: extractPlanLabel(data),
      };
    },
  },
  {
    key: "github-copilot",
    label: "Copilot",
    oauthProviderId: "github-copilot",
    statusUrl: "https://github.com/settings/copilot",
    matches: (provider) => provider === "github-copilot",
    getToken: getGitHubCopilotRefreshToken,
    async fetch(token, signal) {
      const auth = AuthStorage.create();
      const baseUrl = getGitHubApiBaseFromCopilotCredential(auth);
      const data = await fetchJson(`${baseUrl}/copilot_internal/user`, token, signal);
      const premium = data?.quota_snapshots?.premium_interactions as CopilotQuotaSnapshot | undefined;
      const chat = data?.quota_snapshots?.chat as CopilotQuotaSnapshot | undefined;
      const resetDate = data?.quota_reset_date_utc || data?.quota_reset_date || data?.limited_user_reset_date;
      const resetSeconds = resetDate ? secondsUntil(resetDate) : undefined;
      const planLabel = extractCopilotPlanLabel(data, premium);

      return {
        windowLabel: "premium",
        window: quotaUsedPercent(premium),
        weeklyLabel: "chat",
        weekly: quotaUsedPercent(chat),
        windowDetail: quotaDetail(premium),
        weeklyDetail: quotaDetail(chat),
        windowResetsIn: resetSeconds !== undefined ? formatDuration(resetSeconds) : undefined,
        weeklyResetsIn: resetSeconds !== undefined ? formatDuration(resetSeconds) : undefined,
        windowResetProgress: resetProgressFromDate(resetDate, 30 * 24 * 60 * 60),
        weeklyResetProgress: resetProgressFromDate(resetDate, 30 * 24 * 60 * 60),
        planLabel,
        debugLines: [
          `copilot_plan=${String(data?.copilot_plan ?? "(missing)")}`,
          `access_type_sku=${String(data?.access_type_sku ?? "(missing)")}`,
          `premium.entitlement=${String(premium?.entitlement ?? "(missing)")}`,
          `premium.remaining=${String(premium?.remaining ?? premium?.quota_remaining ?? "(missing)")}`,
          `premium.percent_remaining=${String(premium?.percent_remaining ?? "(missing)")}`,
          `premium.unlimited=${String(premium?.unlimited ?? "(missing)")}`,
          `quota_reset_date_utc=${String(data?.quota_reset_date_utc ?? "(missing)")}`,
          `quota_reset_date=${String(data?.quota_reset_date ?? "(missing)")}`,
          `limited_user_reset_date=${String(data?.limited_user_reset_date ?? "(missing)")}`,
        ],
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
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    cached.data.refreshedAt = cached.data.refreshedAt ?? cached.at;
    return cached.data;
  }

  try {
    const auth = AuthStorage.create();
    const token = provider.getToken ? await provider.getToken(auth) : await auth.getApiKey(provider.oauthProviderId);
    if (!token) {
      return { windowLabel: "5h", window: 0, weekly: 0, error: `missing ${provider.oauthProviderId} token; try /login` };
    }

    const data = await withTimeout((signal) => provider.fetch(token, signal));
    data.refreshedAt = Date.now();
    cache.set(provider.key, { data, at: data.refreshedAt });
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
  return `${providerDisplayName(provider, data)} ${renderPlainBar(data.window, data.windowResetProgress)} ${data.window}%`;
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

function providerDisplayName(provider: UsageProvider, data?: UsageData): string {
  if (provider.key === "codex") return "Codex (plus)";
  if (data?.planLabel) return `${provider.label} (${data.planLabel})`;
  return provider.label;
}

function usageLine(label: string, value: number, resetProgressPercent?: number, detail?: string): string {
  return `  ${label.padEnd(7)} ${renderPlainBar(value, resetProgressPercent)} ${value}%${detail ? ` (${detail})` : ""}`;
}

function usageSourceLine(provider: UsageProvider, data: UsageData): string | undefined {
  const refreshed = formatRefreshTime(data.refreshedAt);
  if (provider.statusUrl) return `- ${provider.statusUrl}${refreshed ? ` - refreshed ${refreshed}` : ""}`;
  if (refreshed) return `- refreshed ${refreshed}`;
  return undefined;
}

function usageText(provider: UsageProvider, data: UsageData, debug = false): string {
  if (data.error) {
    return [
      provider.label,
      `  error ${data.error}`,
    ].join("\n");
  }

  return [
    providerDisplayName(provider, data),
    usageLine(data.windowLabel, data.window, data.windowResetProgress, data.windowDetail),
    usageLine(data.weeklyLabel ?? "week", data.weekly, data.weeklyResetProgress, data.weeklyDetail),
    ...(debug && data.debugLines?.length ? ["", "Debug", ...data.debugLines.map((line) => `  ${line}`)] : []),
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
  selectedModel = ctx.model;

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

        const model = selectedModel ?? activeCtx.model;
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

  const provider = detectUsageProvider(selectedModel ?? ctx.model);
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
    currentContext = ctx;
    selectedModel = event.model;
    requestFooterRender?.();
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
    description: "Show provider usage: /usage [all|codex|claude|github-copilot|copilot] [refresh] [debug] (pi-scream)",
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const force = tokens.some((token) => token === "refresh" || token === "--refresh" || token === "-f");
      const debug = tokens.some((token) => token === "debug" || token === "--debug");
      const requested = tokens.find((token) => token !== "refresh" && token !== "--refresh" && token !== "-f" && token !== "debug" && token !== "--debug") ?? "all";
      const selectedProviders = requested === "all"
        ? providers
        : providers.filter((p) => p.key === requested || p.label.toLowerCase() === requested || (requested === "copilot" && p.key === "github-copilot"));

      if (selectedProviders.length === 0) {
        const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
        const hint = requested ? `unknown usage provider "${requested}"` : `usage is not supported for current model (${current})`;
        ctx.ui.notify(`pi-scream: ${hint}; try /usage codex, /usage claude, /usage copilot, or /usage all`, "warning");
        return;
      }

      const results = await Promise.all(selectedProviders.map(async (provider) => {
        const data = await getUsage(provider, force);
        return { provider, data };
      }));

      const activeProvider = detectUsageProvider(ctx.model) ?? results[0]?.provider;
      const activeResult = results.find((result) => result.provider === activeProvider) ?? results[0];
      usageInlineText = activeResult ? compactUsage(activeResult.provider, activeResult.data) : undefined;
      requestFooterRender?.();

      const sourceLines = results
        .map(({ provider, data }) => usageSourceLine(provider, data))
        .filter((line): line is string => line !== undefined);
      const text = [
        ...(sourceLines.length > 0 ? ["Source", "----------------------------------------", ...sourceLines, ""] : []),
        "Usage Limits",
        "----------------------------------------",
        results.map(({ provider, data }) => usageText(provider, data, debug)).join("\n\n"),
      ].join("\n");
      ctx.ui.notify(text, results.some(({ data }) => data.error) ? "error" : "info");
    },
  });
}
