import React, { useEffect, useState, useMemo } from 'react';
import { Table, Text, Group, Stack, Loader, useMantineTheme } from '@mantine/core';
import { useQuery, useSubscription } from '@apollo/client';
import { GET_ORDERBOOK, SUBSCRIBE_TO_ORDERBOOK } from '../graphql/queries';
import { formatNumber, formatPrice } from '../utils/formatters';
import { OrderBookLevel } from '../types/market.types';
import { useMarketContext } from '../contexts/MarketContext';
import { Decimal } from 'decimal.js';

interface OrderBookProps {
    market: string;
    depth?: number;
    precision?: number;
}

export const OrderBook: React.FC<OrderBookProps> = ({
    market,
    depth = 15,
    precision = 6
}) => {
    const theme = useMantineTheme();
    const { selectedMarket } = useMarketContext();
    const [orderbook, setOrderbook] = useState<{
        bids: OrderBookLevel[];
        asks: OrderBookLevel[];
        spread: Decimal;
    }>({ bids: [], asks: [], spread: new Decimal(0) });

    const { loading, error } = useQuery(GET_ORDERBOOK, {
        variables: { market },
        onCompleted: (data) => {
            processOrderbook(data.orderbook);
        }
    });

    const { data: realtimeData } = useSubscription(SUBSCRIBE_TO_ORDERBOOK, {
        variables: { market }
    });

    useEffect(() => {
        if (realtimeData?.orderbook) {
            processOrderbook(realtimeData.orderbook);
        }
    }, [realtimeData]);

    const processOrderbook = (data: any) => {
        const bids = data.bids
            .map((bid: any) => ({
                price: new Decimal(bid.price),
                size: new Decimal(bid.size),
                total: new Decimal(bid.total)
            }))
            .slice(0, depth);

        const asks = data.asks
            .map((ask: any) => ({
                price: new Decimal(ask.price),
                size: new Decimal(ask.size),
                total: new Decimal(ask.total)
            }))
            .slice(0, depth);

        const spread = asks[0]?.price.minus(bids[0]?.price) || new Decimal(0);
        
        setOrderbook({ bids, asks, spread });
    };

    const maxTotal = useMemo(() => {
        const maxBidTotal = Math.max(...orderbook.bids.map(b => b.total.toNumber()));
        const maxAskTotal = Math.max(...orderbook.asks.map(a => a.total.toNumber()));
        return Math.max(maxBidTotal, maxAskTotal);
    }, [orderbook]);

    if (error) {
        return <Text color="red">Error loading orderbook: {error.message}</Text>;
    }

    if (loading && !orderbook.bids.length) {
        return <Loader />;
    }

    const renderRow = (level: OrderBookLevel, side: 'bid' | 'ask', maxTotal: number) => {
        const percentage = (level.total.toNumber() / maxTotal) * 100;
        const color = side === 'bid' ? theme.colors.green[4] : theme.colors.red[4];

        return (
            <tr key={level.price.toString()}>
                <td style={{ position: 'relative' }}>
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: 0,
                            width: `${percentage}%`,
                            background: color,
                            opacity: 0.1,
                            zIndex: 0
                        }}
                    />
                    <Text
                        color={side === 'bid' ? 'green' : 'red'}
                        weight={500}
                        style={{ position: 'relative', zIndex: 1 }}
                    >
                        {formatPrice(level.price, precision)}
                    </Text>
                </td>
                <td style={{ textAlign: 'right' }}>
                    {formatNumber(level.size, precision)}
                </td>
                <td style={{ textAlign: 'right' }}>
                    {formatNumber(level.total, precision)}
                </td>
            </tr>
        );
    };

    return (
        <Stack spacing="xs">
            <Group position="apart">
                <Text weight={500} size="sm">Order Book</Text>
                <Text size="xs" color="dimmed">
                    Spread: {formatPrice(orderbook.spread, precision)} (
                    {formatNumber(
                        orderbook.spread.div(orderbook.asks[0]?.price || 1).mul(100),
                        2
                    )}
                    %)
                </Text>
            </Group>

            <Table
                striped
                highlightOnHover
                style={{ tableLayout: 'fixed' }}
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
                        <th>Price</th>
                        <th style={{ textAlign: 'right' }}>Size</th>
                        <th style={{ textAlign: 'right' }}>Total</th>
                    </tr>
                </thead>
                <tbody>
                    {orderbook.asks.slice().reverse().map(ask => 
                        renderRow(ask, 'ask', maxTotal)
                    )}
                    {orderbook.bids.map(bid => 
                        renderRow(bid, 'bid', maxTotal)
                    )}
                </tbody>
            </Table>
        </Stack>
    );
};
