import React, { useEffect, useState, useRef } from 'react';
import { Table, Text, Stack, Group, Badge, ScrollArea } from '@mantine/core';
import { useQuery, useSubscription } from '@apollo/client';
import { GET_RECENT_TRADES, SUBSCRIBE_TO_TRADES } from '../graphql/queries';
import { formatNumber, formatPrice, formatTime } from '../utils/formatters';
import { Trade } from '../types/market.types';
import { useMarketContext } from '../contexts/MarketContext';
import { Decimal } from 'decimal.js';

interface TradeHistoryProps {
    market: string;
    limit?: number;
    maxHeight?: number;
}

export const TradeHistory: React.FC<TradeHistoryProps> = ({
    market,
    limit = 50,
    maxHeight = 400
}) => {
    const viewport = useRef<HTMLDivElement>();
    const { selectedMarket } = useMarketContext();
    const [trades, setTrades] = useState<Trade[]>([]);
    const [autoScroll, setAutoScroll] = useState(true);

    const { loading, error } = useQuery(GET_RECENT_TRADES, {
        variables: { market, limit },
        onCompleted: (data) => {
            setTrades(processTrades(data.recentTrades));
        }
    });

    const { data: realtimeData } = useSubscription(SUBSCRIBE_TO_TRADES, {
        variables: { market }
    });

    useEffect(() => {
        if (realtimeData?.trade) {
            const newTrade = processTrade(realtimeData.trade);
            setTrades(prev => [newTrade, ...prev].slice(0, limit));

            if (autoScroll && viewport.current) {
                viewport.current.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
    }, [realtimeData]);

    const processTrade = (trade: any): Trade => ({
        id: trade.id,
        market: trade.market,
        price: new Decimal(trade.price),
        size: new Decimal(trade.size),
        side: trade.side,
        timestamp: new Date(trade.timestamp),
        maker: trade.maker,
        taker: trade.taker,
        feeCost: new Decimal(trade.feeCost)
    });

    const processTrades = (trades: any[]): Trade[] =>
        trades.map(processTrade);

    const handleScroll = () => {
        if (!viewport.current) return;
        
        const { scrollTop } = viewport.current;
        setAutoScroll(scrollTop === 0);
    };

    if (error) {
        return <Text color="red">Error loading trades: {error.message}</Text>;
    }

    return (
        <Stack spacing="xs">
            <Group position="apart">
                <Text weight={500} size="sm">Trade History</Text>
                <Badge
                    size="sm"
                    variant="outline"
                    color={autoScroll ? 'blue' : 'gray'}
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setAutoScroll(!autoScroll)}
                >
                    Auto-scroll {autoScroll ? 'ON' : 'OFF'}
                </Badge>
            </Group>

            <ScrollArea
                viewportRef={viewport}
                style={{ height: maxHeight }}
                onScrollPositionChange={handleScroll}
                scrollbarSize={8}
            >
                <Table
                    striped
                    highlightOnHover
                    sx={{
                        'th, td': {
                            padding: '4px 8px',
                            whiteSpace: 'nowrap',
                            fontSize: '0.875rem'
                        }
                    }}
                >
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Price</th>
                            <th style={{ textAlign: 'right' }}>Size</th>
                            <th style={{ textAlign: 'right' }}>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {trades.map(trade => (
                            <tr key={trade.id}>
                                <td>
                                    <Text size="xs" color="dimmed">
                                        {formatTime(trade.timestamp)}
                                    </Text>
                                </td>
                                <td>
                                    <Text
                                        color={trade.side === 'buy' ? 'green' : 'red'}
                                        weight={500}
                                    >
                                        {formatPrice(trade.price)}
                                    </Text>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    {formatNumber(trade.size)}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    {formatNumber(trade.price.mul(trade.size))}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </Table>
            </ScrollArea>
        </Stack>
    );
};
