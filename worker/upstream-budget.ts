// Limit cache misses before they consume the shared upstream API subscription.
export interface UpstreamRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export class UpstreamBudget {
  private used = 0;
  private readonly limiter: UpstreamRateLimiter;
  private readonly maxPerRequest: number;

  constructor(limiter: UpstreamRateLimiter, maxPerRequest: number) {
    this.limiter = limiter;
    this.maxPerRequest = maxPerRequest;
  }

  async reserve(): Promise<boolean> {
    if (this.used >= this.maxPerRequest) return false;
    // Increment before awaiting so parallel layer requests cannot overrun this request's budget.
    this.used++;
    return (await this.limiter.limit({ key: "reinfolib-upstream" })).success;
  }
}
