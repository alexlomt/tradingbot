import React, { useEffect, useState } from 'react';
import { Grid, Box, Paper, Typography } from '@mui/material';
import { SystemHealthPanel } from './panels/SystemHealthPanel';
import { TradingMetricsPanel } from './panels/TradingMetricsPanel';
import { ErrorRatesPanel } from './panels/ErrorRatesPanel';
import { BackupStatusPanel } from './panels/BackupStatusPanel';
import { CircuitBreakerPanel } from './panels/CircuitBreakerPanel';
import { AlertsTimeline } from './panels/AlertsTimeline';
import { useMonitoringData } from '../../hooks/useMonitoringData';
import { MonitoringTimeframe } from '../../types/monitoring.types';
import { TimeframeSelector } from '../common/TimeframeSelector';
import { LoadingOverlay } from '../common/LoadingOverlay';
import { ErrorBoundary } from '../common/ErrorBoundary';

export const MonitoringDashboard: React.FC = () => {
    const [timeframe, setTimeframe] = useState<MonitoringTimeframe>('1h');
    const {
        systemHealth,
        tradingMetrics,
        errorRates,
        backupStatus,
        circuitBreakerStatus,
        alerts,
        isLoading,
        error,
        refresh
    } = useMonitoringData(timeframe);

    useEffect(() => {
        const interval = setInterval(refresh, 30000); // Refresh every 30 seconds
        return () => clearInterval(interval);
    }, [refresh]);

    if (error) {
        return (
            <Box p={3}>
                <Typography color="error" variant="h6">
                    Error loading monitoring data: {error.message}
                </Typography>
            </Box>
        );
    }

    return (
        <Box p={3}>
            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                        <Typography variant="h4">System Monitoring</Typography>
                        <TimeframeSelector
                            value={timeframe}
                            onChange={(value) => setTimeframe(value as MonitoringTimeframe)}
                            options={[
                                { value: '1h', label: 'Last Hour' },
                                { value: '24h', label: 'Last 24 Hours' },
                                { value: '7d', label: 'Last 7 Days' },
                                { value: '30d', label: 'Last 30 Days' }
                            ]}
                        />
                    </Box>
                </Grid>

                <Grid item xs={12} lg={8}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2, height: '100%' }}>
                            <LoadingOverlay loading={isLoading}>
                                <SystemHealthPanel data={systemHealth} />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>

                <Grid item xs={12} lg={4}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2, height: '100%' }}>
                            <LoadingOverlay loading={isLoading}>
                                <CircuitBreakerPanel data={circuitBreakerStatus} />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>

                <Grid item xs={12}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2 }}>
                            <LoadingOverlay loading={isLoading}>
                                <TradingMetricsPanel
                                    data={tradingMetrics}
                                    timeframe={timeframe}
                                />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>

                <Grid item xs={12} md={6}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2, height: '100%' }}>
                            <LoadingOverlay loading={isLoading}>
                                <ErrorRatesPanel
                                    data={errorRates}
                                    timeframe={timeframe}
                                />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>

                <Grid item xs={12} md={6}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2, height: '100%' }}>
                            <LoadingOverlay loading={isLoading}>
                                <BackupStatusPanel data={backupStatus} />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>

                <Grid item xs={12}>
                    <ErrorBoundary>
                        <Paper sx={{ p: 2 }}>
                            <LoadingOverlay loading={isLoading}>
                                <AlertsTimeline
                                    alerts={alerts}
                                    timeframe={timeframe}
                                />
                            </LoadingOverlay>
                        </Paper>
                    </ErrorBoundary>
                </Grid>
            </Grid>
        </Box>
    );
};
