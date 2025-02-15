import React, { useEffect, useState } from 'react';
import { 
    LineChart, 
    BarChart, 
    AreaChart,
    Line, 
    Bar, 
    Area,
    XAxis, 
    YAxis, 
    CartesianGrid, 
    Tooltip, 
    Legend,
    ResponsiveContainer 
} from 'recharts';
import { 
    Box,
    Grid,
    Card,
    CardHeader,
    CardContent,
    Typography,
    CircularProgress,
    Select,
    MenuItem
} from '@mui/material';
import { formatNumber, formatDate } from '../../utils/formatters';
import { useMetricsData } from '../../hooks/useMetricsData';
import { MetricsTimeframe } from '../../types/metrics.types';
import { TradingMetricsPanel } from './TradingMetricsPanel';
import { SystemMetricsPanel } from './SystemMetricsPanel';
import { AlertsPanel } from './AlertsPanel';

export const MetricsDashboard: React.FC = () => {
    const [timeframe, setTimeframe] = useState<MetricsTimeframe>('24h');
    const { 
        tradingMetrics,
        systemMetrics,
        alerts,
        isLoading,
        error 
    } = useMetricsData(timeframe);

    if (isLoading) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
                <CircularProgress />
            </Box>
        );
    }

    if (error) {
        return (
            <Box p={3}>
                <Typography color="error">
                    Error loading metrics: {error.message}
                </Typography>
            </Box>
        );
    }

    return (
        <Box p={3}>
            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                        <Typography variant="h4">Trading Bot Metrics</Typography>
                        <Select
                            value={timeframe}
                            onChange={(e) => setTimeframe(e.target.value as MetricsTimeframe)}
                            size="small"
                        >
                            <MenuItem value="1h">Last Hour</MenuItem>
                            <MenuItem value="24h">Last 24 Hours</MenuItem>
                            <MenuItem value="7d">Last 7 Days</MenuItem>
                            <MenuItem value="30d">Last 30 Days</MenuItem>
                        </Select>
                    </Box>
                </Grid>

                {/* Trading Metrics */}
                <Grid item xs={12} lg={8}>
                    <TradingMetricsPanel metrics={tradingMetrics} timeframe={timeframe} />
                </Grid>

                {/* System Health */}
                <Grid item xs={12} lg={4}>
                    <SystemMetricsPanel metrics={systemMetrics} />
                </Grid>

                {/* Trading Volume Chart */}
                <Grid item xs={12}>
                    <Card>
                        <CardHeader title="Trading Volume" />
                        <CardContent>
                            <ResponsiveContainer width="100%" height={300}>
                                <AreaChart data={tradingMetrics.volumeHistory}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis 
                                        dataKey="timestamp" 
                                        tickFormatter={(value) => formatDate(value, timeframe)}
                                    />
                                    <YAxis 
                                        tickFormatter={(value) => formatNumber(value, 'currency')}
                                    />
                                    <Tooltip
                                        formatter={(value: number) => formatNumber(value, 'currency')}
                                        labelFormatter={(label) => formatDate(label, timeframe)}
                                    />
                                    <Legend />
                                    <Area
                                        type="monotone"
                                        dataKey="volume"
                                        stroke="#8884d8"
                                        fill="#8884d8"
                                        fillOpacity={0.3}
                                        name="Trading Volume"
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </Grid>

                {/* Success Rate Chart */}
                <Grid item xs={12} md={6}>
                    <Card>
                        <CardHeader title="Trade Success Rate" />
                        <CardContent>
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={tradingMetrics.successRateHistory}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis 
                                        dataKey="timestamp"
                                        tickFormatter={(value) => formatDate(value, timeframe)}
                                    />
                                    <YAxis 
                                        domain={[0, 100]}
                                        tickFormatter={(value) => `${value}%`}
                                    />
                                    <Tooltip
                                        formatter={(value: number) => `${value.toFixed(2)}%`}
                                        labelFormatter={(label) => formatDate(label, timeframe)}
                                    />
                                    <Legend />
                                    <Line
                                        type="monotone"
                                        dataKey="successRate"
                                        stroke="#82ca9d"
                                        name="Success Rate"
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </Grid>

                {/* Profit/Loss Chart */}
                <Grid item xs={12} md={6}>
                    <Card>
                        <CardHeader title="Profit/Loss" />
                        <CardContent>
                            <ResponsiveContainer width="100%" height={300}>
                                <BarChart data={tradingMetrics.profitLossHistory}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis 
                                        dataKey="timestamp"
                                        tickFormatter={(value) => formatDate(value, timeframe)}
                                    />
                                    <YAxis 
                                        tickFormatter={(value) => formatNumber(value, 'currency')}
                                    />
                                    <Tooltip
                                        formatter={(value: number) => formatNumber(value, 'currency')}
                                        labelFormatter={(label) => formatDate(label, timeframe)}
                                    />
                                    <Legend />
                                    <Bar
                                        dataKey="profit"
                                        fill="#82ca9d"
                                        name="Profit"
                                        stackId="a"
                                    />
                                    <Bar
                                        dataKey="loss"
                                        fill="#ff8042"
                                        name="Loss"
                                        stackId="a"
                                    />
                                </BarChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </Grid>

                {/* Alerts Panel */}
                <Grid item xs={12}>
                    <AlertsPanel alerts={alerts} />
                </Grid>
            </Grid>
        </Box>
    );
};
