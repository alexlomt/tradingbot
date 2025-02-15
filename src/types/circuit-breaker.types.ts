export enum CircuitState {
    CLOSED = 'CLOSED',
    OPEN = 'OPEN',
    HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitConfig {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
    monitoringPeriodMs: number;
    resetTimeoutMs: number;
}

export interface CircuitStats {
    successes: number;
    failures: number;
    totalResponses: number;
    responseTimeSum: number;
    lastSuccess: number;
    lastFailure: number;
    lastError: string | null;
}

export interface CircuitMetrics {
    state: CircuitState;
    successRate: number;
    averageResponseTime: number;
    totalCalls: number;
}
