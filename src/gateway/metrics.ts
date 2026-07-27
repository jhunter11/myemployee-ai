export interface MetricsSnapshot {
  totalRequests: number;
  errors: number;
  lastRunAtByClient: Record<string, string>;
}

export class RequestMetrics {
  private totalRequests = 0;
  private errors = 0;
  private readonly lastRunAtByClient = new Map<string, string>();

  recordRequest(): void {
    this.totalRequests += 1;
  }

  recordError(): void {
    this.errors += 1;
  }

  recordRun(clientId: string, at: string): void {
    this.lastRunAtByClient.set(clientId, at);
  }

  snapshot(): MetricsSnapshot {
    return {
      totalRequests: this.totalRequests,
      errors: this.errors,
      lastRunAtByClient: Object.fromEntries(this.lastRunAtByClient)
    };
  }
}
