import type { CommandCodeQuota, CommandCodeWindowLimit } from "./quota-types.ts"

const BAR_WIDTH = 20
const BAR_FILLED = "█"
const BAR_EMPTY = "░"

const WINDOW_LABELS: Record<CommandCodeWindowLimit["window"], string> = {
  fiveHour: "5-hour",
  weekly: "Weekly",
}

function progressBar(used: number, cap: number): { bar: string; percent: number } {
  const percent = cap > 0 ? Math.round((used / cap) * 100) : 0
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return { bar: BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled), percent }
}

function windowLine(limit: CommandCodeWindowLimit, now: () => number): string {
  const { bar, percent } = progressBar(limit.used, limit.cap)
  const amounts = `$${limit.used.toFixed(2)} / $${limit.cap.toFixed(2)}`
  const reset = limit.resetAt === null ? "" : ` · resets ${formatResetClock(limit.resetAt, now)}`
  return `${WINDOW_LABELS[limit.window].padEnd(7)} ${bar}  ${percent}% used · ${amounts}${reset}`
}

export function formatWindowLimits(
  limits: readonly CommandCodeWindowLimit[],
  now: () => number = Date.now,
): string[] {
  return limits.map((limit) => windowLine(limit, now))
}

function formatResetClock(resetAtSeconds: number, now: () => number): string {
  const date = new Date(resetAtSeconds * 1000)
  if (Number.isNaN(date.getTime())) return "unknown"
  const diffMs = date.getTime() - now()
  if (diffMs <= 0) return "soon"
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `in ${hours}h ${remainingMinutes}m` : `in ${hours}h`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? "in 1 day" : `in ${days} days`
}

function parsePeriodEnd(value: string): Date | null {
  const trimmed = value.trim()
  const timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  if (!Number.isFinite(timestamp) || timestamp < 0) return null
  const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Renewal suffix for the monthly line, e.g. " · renews Feb 1 (17d)". */
function renewalSuffix(quota: CommandCodeQuota, now: () => number): string {
  const periodEnd = quota.subscription?.currentPeriodEnd
  if (!periodEnd) return ""
  const end = parsePeriodEnd(periodEnd)
  if (!end) return ""

  const dateStr = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  const days = Math.ceil((end.getTime() - now()) / 86_400_000)
  if (days > 0) return ` · renews ${dateStr} (${days}d)`
  if (days === 0) return ` · renews ${dateStr} (today)`
  return ` · renewed ${dateStr}`
}

function monthlyLine(quota: CommandCodeQuota, now: () => number): string {
  const spent = quota.summary?.totalCost
  const remaining = quota.credits?.remainingCredits
  const renewal = renewalSuffix(quota, now)

  if (spent === undefined && remaining === undefined) {
    return `Monthly unavailable${renewal}`
  }
  if (spent === undefined || remaining === undefined) {
    const used = spent ?? 0
    return `Monthly $${used.toFixed(2)} used (cap unavailable)${renewal}`
  }

  const pool = remaining + spent
  const { bar, percent } = progressBar(spent, pool)
  return `Monthly ${bar}  ${percent}% used · $${spent.toFixed(2)} / $${pool.toFixed(2)}${renewal}`
}

export function formatQuota(quota: CommandCodeQuota, now: () => number = Date.now): string {
  const limits = quota.credits?.windowLimits ?? []
  const lines = (["fiveHour", "weekly"] as const).map((window) => {
    const limit = limits.find((entry) => entry.window === window)
    return limit ? windowLine(limit, now) : `${WINDOW_LABELS[window].padEnd(7)} unavailable`
  })

  lines.push(monthlyLine(quota, now))

  if ((quota.unavailable?.length ?? 0) > 0) {
    lines.push("")
    lines.push(`Unavailable: ${quota.unavailable?.join(", ")}`)
  }

  return lines.join("\n")
}
