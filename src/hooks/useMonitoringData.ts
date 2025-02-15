import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { monitoringApi } from '../api/monitoring';
import { 
    MonitoringTimeframe,
    MonitoringData,
    SystemHealth,
    TradingMetrics,
    ErrorRates,
    BackupStatus,
    CircuitBreakerStatus,
    SystemAlert
} from '../types/monitoring.types';

export const useMonitoringData = (timeframe: MonitoringTimeframe) => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [data, setData] = useState<MonitoringData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const fetchData = useCallback(async () => {
        try {
            setIsLoading(true);
            const [
                systemHealth,
                tradingMetrics,
                errorRates,
                backupStatus,
                circuitBreakerStatus,
                alerts
            ] = await Promise.all([
                monitoringApi.getSystemHealth(),
                monitoringApi.getTradingMetrics(timeframe),
                monitoringApi.getErrorRates(timeframe),
                monitoringApi.getBackupStatus(),
                monitoringApi.getCircuitBreakerStatus(),
                monitoringApi.getAlerts(timeframe)
            ]);

            setData({
                systemHealth,
                tradingMetrics,
                errorRates,
                backupStatus,
                circuitBreakerStatus,
                alerts
            });
        } catch (err) {
            setError(err as Error);
        } finally {
            setIsLoading(false);
        }
    }, [timeframe]);

    useEffect(() => {
        fetchData();

        const newSocket = io('/monitoring', {
            path: '/api/ws',
            query: { timeframe }
        });

        newSocket.on('systemHealth', (health: SystemHealth) => {
            setData(prev => prev ? { ...prev, systemHealth: health } : null);
        });

        newSocket.on('tradingMetrics', (metrics: TradingMetrics) => {
            setData(prev => prev ? { ...prev, tradingMetrics: metrics } : null);
        });

        newSocket.on('errorRates', (rates: ErrorRates) => {
            setData(prev => prev ? { ...prev, errorRates: rates } : null);
        });

        newSocket.on('backupStatus', (status: BackupStatus) => {
            setData(prev => prev ? { ...prev, backupStatus: status } : null);
        });

        newSocket.on('circuitBreakerStatus', (status: CircuitBreakerStatus) => {
            setData(prev => prev ? { ...prev, circuitBreakerStatus: status } : null);
        });

        newSocket.on('alert', (alert: SystemAlert) => {
            setData(prev => prev ? {
                ...prev,
                alerts: [alert, ...prev.alerts].slice(0, 100)
            } : null);
        });

        setSocket(newSocket);

        return () => {
            newSocket.close();
        };
    }, [timeframe, fetchData]);

    return {
        ...(data || {
            systemHealth: null,
            tradingMetrics: null,
            errorRates: null,
            backupStatus: null,
            circuitBreakerStatus: null,
            alerts: []
        }),
        isLoading,
        error,
        refresh: fetchData
    };
};
