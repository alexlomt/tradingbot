import React from 'react';
import { 
    Card, 
    CardHeader, 
    CardContent, 
    Grid, 
    Typography,
    Box,
    Tooltip,
    IconButton
} from '@mui/material';
import { InfoOutlined, TrendingUp, TrendingDown } from '@mui/icons-material';
import { TradingMetrics, MetricsTimeframe } from '../../types/metrics.types';
import { formatNumber, formatPercentage } from '../../utils/formatters';

interface TradingMetricsPanelProps {
    metrics: TradingMetrics;
    timeframe: MetricsTimeframe;
}

export const TradingMetricsPanel: React.FC<TradingMetricsPanelProps> = ({ 
    metrics,
    timeframe 
}) => {
    return (
        <Card>
            <CardHeader 
                title="Trading Performance"
                action={
                    <Tooltip title="Real-time trading performance metrics">
                        <IconButton size="small">
                            <InfoOutlined />
                        </IconButton>
                    </Tooltip>
                }
            />
            <CardContent>
                <Grid container spacing={3}>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="Total Volume"
                            value={formatNumber(metrics.totalVolume, 'currency')}
                            change={metrics.volumeChange}
                            timeframe={timeframe}
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="Success Rate"
                            value={`${formatPercentage(metrics.successRate)}%`}
                            change={metrics.successRateChange}
                            timeframe={timeframe}
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="Net Profit"
                            value={formatNumber(metrics.netProfit, 'currency')}
                            change={metrics.profitChange}
                            timeframe={timeframe}
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="Active Trades"
                            value={metrics.activeTrades.toString()}
                            change={metrics.activeTradesChange}
                            timeframe={timeframe}
                        />
                    </Grid>
                </Grid>
            </CardContent>
        </Card>
    );
};

interface MetricCardProps {
    title: string;
    value: string;
    change: number;
    timeframe: MetricsTimeframe;
}

const MetricCard: React.FC<MetricCardProps> = ({ 
    title,
    value,
    change,
    timeframe 
}) => {
    const timeframeLabel = {
        '1h': 'hour',
        '24h': 'day',
        '7d': 'week',
        '30d': 'month'
    }[timeframe];

    return (
        <Box>
            <Typography variant="subtitle2" color="textSecondary">
                {title}
            </Typography>
            <Typography variant="h4" component="div">
                {value}
            </Typography>
            <Box display="flex" alignItems="center" mt={1}>
                {change > 0 ? (
                    <TrendingUp color="success" fontSize="small" />
                ) : (
                    <TrendingDown color="error" fontSize="small" />
                )}
                <Typography
                    variant="body2"
                    color={change > 0 ? 'success.main' : 'error.main'}
                    ml={0.5}
                >
                    {formatPercentage(Math.abs(change))}%
                </Typography>
                <Typography variant="body2" color="textSecondary" ml={1}>
                    vs last {timeframeLabel}
                </Typography>
            </Box>
        </Box>
    );
};
