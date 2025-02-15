import { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { MetricsTimeframe } from '../types/metrics.types';
import { metricsApi } from '../api/metrics';

export const useMetricsData = (timeframe: MetricsTimeframe) => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [tradingMetrics, setTradingMetrics] = useState(null);
    const [systemMetrics, setSystemMetrics] = useState(null);
    const [alerts, setAlerts] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        // Initial data fetch
        const fetchData = async () => {
            try {
                setIsLoading(true);
                const [trading, system, alertsData] = await Promise.all([
                    metricsApi.getTradingMetrics(timeframe),
                    metricsApi.getSystemMetrics(),
                    metricsApi.getAlerts()
                ]);
                
                setTradingMetrics(trading);
                setSystemMetrics(system);
                setAlerts(alertsData);
            } catch (err) {
                setError(err as Error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();

        // WebSocket connection for real-time updates
        const newSocket = io('/metrics', {
            path: '/api/ws',
            query: { timeframe }
        });

        newSocket.on('tradingMetrics', (data) => {
            setTradingMetrics((prev) => ({
                ...prev,
                ...data
            }));
        });

        newSocket.on('systemMetrics', (data) => {
            setSystemMetrics((prev) => ({
                ...prev,
                ...data
            }));
        });

        newSocket.on('alert', (alert) => {
            setAlerts((prev) => [alert, ...prev].slice(0, 100));
        });

        setSocket(newSocket);

        return () => {
            newSocket.close();
        };
    }, [timeframe]);

    // Update data when timeframe changes
    useEffect(() => {
        if (socket) {
            socket.emit('updateTimeframe', timeframe);
        }
    }, [timeframe, socket]);

    return {
        tradingMetrics,
        systemMetrics,
        alerts,
        isLoading,
        error
    };
};
