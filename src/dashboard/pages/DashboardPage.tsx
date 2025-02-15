import React, { useEffect, useState, useMemo } from 'react';
import {
    Grid,
    Card,
    Text,
    Group,
    Stack,
    Button,
    Table,
    Badge,
    Select,
    LoadingOverlay,
    useMantineTheme,
    RingProgress,
    Timeline
} from '@mantine/core';
import {
    IconArrowUpRight,
    IconArrowDownRight,
    IconCurrencyDollar,
    IconChartLine,
    IconWallet,
    IconAlertCircle
} from '@tabler/icons-react';
import { useQuery, useSubscription } from '@apollo/client';
import { LineChart, AreaChart, PieChart } from '@tremor/react';
import { GET_TRADING_METRICS, GET_ACTIVE_POSITIONS } from '../../graphql/queries';
import { SUBSCRIBE_TO_MARKET_UPDATES } from '../../graphql/subscriptions';
import { formatCurrency, formatPercentage } from '../../utils/formatters';
import { TradingStatus } from '../../types/trading.types';
import { useTradingContext } from '../../contexts/TradingContext';
import { OrderBook } from '../../components/OrderBook';
import { TradeHistory } from '../../components/TradeHistory';
import { PositionTable } from '../../components/PositionTable';
import { AlertsList } from '../../components/AlertsList';
import { MarketDepthChart } from '../../components/MarketDepthChart';
import { StrategyControls } from '../../components/StrategyControls';

const DashboardPage: React.FC = () => {
    const theme = useMantineTheme();
    const { tradingStatus, toggleTrading, updateStrategy } = useTradingContext();
    const [selectedMarket, setSelectedMarket] = useState<string>('');
    const [timeframe, setTimeframe] = useState('1d');

    // Fetch trading metrics
    const { data: metricsData, loading: metricsLoading } = useQuery(GET_TRADING_METRICS, {
        variables: { market: selectedMarket, timeframe },
        pollInterval: 5000
    });

    // Fetch active positions
    const { data: positionsData, loading: positionsLoading } = useQuery(GET_ACTIVE_POSITIONS, {
        variables: { market: selectedMarket },
        pollInterval: 10000
    });

    // Subscribe to market updates
    const { data: marketData } = useSubscription(SUBSCRIBE_TO_MARKET_UPDATES, {
        variables: { market: selectedMarket }
    });

    const metrics = useMemo(() => metricsData?.tradingMetrics || {}, [metricsData]);
    const positions = useMemo(() => positionsData?.activePositions || [], [positionsData]);

    const pnlData = useMemo(() => {
        if (!metrics.pnlHistory) return [];
        return metrics.pnlHistory.map((point: any) => ({
            date: new Date(point.timestamp).toLocaleDateString(),
            pnl: point.value
        }));
    }, [metrics.pnlHistory]);

    return (
        <Stack spacing="md">
            {/* Trading Status and Controls */}
            <Card shadow="sm">
                <Group position="apart">
                    <Group>
                        <Select
                            label="Market"
                            value={selectedMarket}
                            onChange={setSelectedMarket}
                            data={metrics.availableMarkets || []}
                            style={{ width: 200 }}
                        />
                        <Select
                            label="Timeframe"
                            value={timeframe}
                            onChange={setTimeframe}
                            data={[
                                { value: '1h', label: '1 Hour' },
                                { value: '1d', label: '1 Day' },
                                { value: '1w', label: '1 Week' },
                                { value: '1m', label: '1 Month' }
                            ]}
                            style={{ width: 150 }}
                        />
                    </Group>
                    <Button
                        color={tradingStatus === TradingStatus.ACTIVE ? 'red' : 'green'}
                        onClick={toggleTrading}
                    >
                        {tradingStatus === TradingStatus.ACTIVE ? 'Stop Trading' : 'Start Trading'}
                    </Button>
                </Group>
            </Card>

            {/* Performance Metrics */}
            <Grid>
                <Grid.Col span={3}>
                    <Card shadow="sm">
                        <Stack>
                            <Text size="sm" color="dimmed">Total P&L</Text>
                            <Group position="apart">
                                <Text size="xl" weight={700} color={metrics.totalPnL >= 0 ? 'green' : 'red'}>
                                    {formatCurrency(metrics.totalPnL)}
                                </Text>
                                <Badge
                                    color={metrics.dailyPnLPercentage >= 0 ? 'green' : 'red'}
                                    variant="light"
                                >
                                    {formatPercentage(metrics.dailyPnLPercentage)}
                                </Badge>
                            </Group>
                        </Stack>
                    </Card>
                </Grid.Col>
                <Grid.Col span={3}>
                    <Card shadow="sm">
                        <Stack>
                            <Text size="sm" color="dimmed">Win Rate</Text>
                            <Group position="apart">
                                <RingProgress
                                    size={80}
                                    roundCaps
                                    thickness={8}
                                    sections={[{ value: metrics.winRate * 100, color: 'blue' }]}
                                    label={
                                        <Text size="xs" align="center">
                                            {formatPercentage(metrics.winRate)}
                                        </Text>
                                    }
                                />
                                <Stack spacing={0}>
                                    <Text size="sm">Wins: {metrics.winningTrades}</Text>
                                    <Text size="sm">Losses: {metrics.losingTrades}</Text>
                                </Stack>
                            </Group>
                        </Stack>
                    </Card>
                </Grid.Col>
                <Grid.Col span={3}>
                    <Card shadow="sm">
                        <Stack>
                            <Text size="sm" color="dimmed">Average Trade</Text>
                            <Group position="apart">
                                <Text size="xl" weight={700}>
                                    {formatCurrency(metrics.averageTradeReturn)}
                                </Text>
                                <IconChartLine size={24} />
                            </Group>
                        </Stack>
                    </Card>
                </Grid.Col>
                <Grid.Col span={3}>
                    <Card shadow="sm">
                        <Stack>
                            <Text size="sm" color="dimmed">Current Exposure</Text>
                            <Group position="apart">
                                <Text size="xl" weight={700}>
                                    {formatCurrency(metrics.currentExposure)}
                                </Text>
                                <Badge color={metrics.exposureLevel}>
                                    {metrics.exposureLevel.toUpperCase()}
                                </Badge>
                            </Group>
                        </Stack>
                    </Card>
                </Grid.Col>
            </Grid>

            {/* Charts and Order Book */}
            <Grid>
                <Grid.Col span={8}>
                    <Card shadow="sm" style={{ height: 400 }}>
                        <LoadingOverlay visible={metricsLoading} />
                        <Stack>
                            <Group position="apart">
                                <Text weight={500}>P&L History</Text>
                                <Badge>{timeframe.toUpperCase()}</Badge>
                            </Group>
                            <AreaChart
                                data={pnlData}
                                index="date"
                                categories={["pnl"]}
                                colors={["blue"]}
                                valueFormatter={formatCurrency}
                                showLegend={false}
                                height={300}
                            />
                        </Stack>
                    </Card>
                </Grid.Col>
                <Grid.Col span={4}>
                    <OrderBook
                        market={selectedMarket}
                        data={marketData?.orderBook}
                        loading={!marketData}
                    />
                </Grid.Col>
            </Grid>

            {/* Positions and Trade History */}
            <Grid>
                <Grid.Col span={8}>
                    <PositionTable
                        positions={positions}
                        loading={positionsLoading}
                        onPositionClose={(positionId) => {
                            // Handle position close
                        }}
                    />
                </Grid.Col>
                <Grid.Col span={4}>
                    <Stack>
                        <TradeHistory
                            market={selectedMarket}
                            data={marketData?.recentTrades}
                            maxHeight={300}
                        />
                        <AlertsList
                            alerts={metrics.activeAlerts || []}
                            onAlertDismiss={(alertId) => {
                                // Handle alert dismiss
                            }}
                        />
                    </Stack>
                </Grid.Col>
            </Grid>

            {/* Strategy Controls */}
            <Card shadow="sm">
                <StrategyControls
                    currentStrategy={metrics.currentStrategy}
                    parameters={metrics.strategyParameters}
                    onUpdate={updateStrategy}
                />
            </Card>
        </Stack>
    );
};

export default DashboardPage;
