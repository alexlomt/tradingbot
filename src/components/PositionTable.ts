import React, { useEffect, useState } from 'react';
import { Table, Badge, ActionIcon, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { useQuery, useSubscription } from '@apollo/client';
import { IconArrowUp, IconArrowDown, IconX, IconAdjustments } from '@tabler/icons-react';
import { formatNumber, formatPrice, formatPercent } from '../utils/formatters';
import { GET_POSITIONS, SUBSCRIBE_TO_POSITIONS } from '../graphql/queries';
import { useTrading } from '../hooks/useTrading';
import { Position } from '../types/trading.types';
import { Decimal } from 'decimal.js';
import { PositionSettingsModal } from './PositionSettingsModal';
import { useNotifications } from '../hooks/useNotifications';

interface PositionTableProps {
    onPositionSelect?: (position: Position) => void;
    compact?: boolean;
}

export const PositionTable: React.FC<PositionTableProps> = ({
    onPositionSelect,
    compact = false
}) => {
    const { closePosition, updateStopLoss, updateTakeProfit } = useTrading();
    const { showNotification } = useNotifications();
    const [positions, setPositions] = useState<Position[]>([]);
    const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const { loading, error } = useQuery(GET_POSITIONS, {
        onCompleted: (data) => {
            setPositions(processPositions(data.positions));
        }
    });

    const { data: realtimeData } = useSubscription(SUBSCRIBE_TO_POSITIONS);

    useEffect(() => {
        if (realtimeData?.positions) {
            setPositions(processPositions(realtimeData.positions));
        }
    }, [realtimeData]);

    const processPositions = (rawPositions: any[]): Position[] => {
        return rawPositions.map(pos => ({
            ...pos,
            size: new Decimal(pos.size),
            avgEntryPrice: new Decimal(pos.avgEntryPrice),
            markPrice: new Decimal(pos.markPrice),
            unrealizedPnL: new Decimal(pos.unrealizedPnL),
            realizedPnL: new Decimal(pos.realizedPnL),
            stopLoss: pos.stopLoss ? new Decimal(pos.stopLoss) : null,
            takeProfit: pos.takeProfit ? new Decimal(pos.takeProfit) : null,
            liquidationPrice: new Decimal(pos.liquidationPrice)
        }));
    };

    const handleClosePosition = async (position: Position) => {
        try {
            await closePosition(position.market);
            showNotification({
                title: 'Position Closed',
                message: `Successfully closed position for ${position.market}`,
                type: 'success'
            });
        } catch (error) {
            showNotification({
                title: 'Error',
                message: `Failed to close position: ${error.message}`,
                type: 'error'
            });
        }
    };

    const handleSettingsUpdate = async (
        position: Position,
        stopLoss: Decimal | null,
        takeProfit: Decimal | null
    ) => {
        try {
            if (stopLoss !== position.stopLoss) {
                await updateStopLoss(position.market, stopLoss);
            }
            if (takeProfit !== position.takeProfit) {
                await updateTakeProfit(position.market, takeProfit);
            }
            setIsSettingsOpen(false);
            showNotification({
                title: 'Settings Updated',
                message: 'Position settings successfully updated',
                type: 'success'
            });
        } catch (error) {
            showNotification({
                title: 'Error',
                message: `Failed to update settings: ${error.message}`,
                type: 'error'
            });
        }
    };

    if (error) {
        return <Text color="red">Error loading positions: {error.message}</Text>;
    }

    return (
        <>
            <Table 
                striped 
                highlightOnHover
                sx={{ 
                    'th, td': { 
                        padding: compact ? '8px' : '12px',
                        fontSize: compact ? '0.875rem' : '1rem'
                    }
                }}
            >
                <thead>
                    <tr>
                        <th>Market</th>
                        <th>Side</th>
                        <th style={{ textAlign: 'right' }}>Size</th>
                        <th style={{ textAlign: 'right' }}>Entry Price</th>
                        <th style={{ textAlign: 'right' }}>Mark Price</th>
                        <th style={{ textAlign: 'right' }}>PnL</th>
                        <th style={{ textAlign: 'right' }}>ROE%</th>
                        {!compact && (
                            <>
                                <th style={{ textAlign: 'right' }}>Liquidation</th>
                                <th style={{ textAlign: 'right' }}>Value</th>
                            </>
                        )}
                        <th style={{ textAlign: 'center' }}>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {positions.map((position) => {
                        const pnlColor = position.unrealizedPnL.isPositive() ? 'green' : 'red';
                        const roe = position.unrealizedPnL
                            .div(position.avgEntryPrice.mul(position.size))
                            .mul(100);

                        return (
                            <tr 
                                key={position.market}
                                onClick={() => onPositionSelect?.(position)}
                                style={{ cursor: onPositionSelect ? 'pointer' : 'default' }}
                            >
                                <td>
                                    <Text weight={500}>{position.market}</Text>
                                </td>
                                <td>
                                    <Badge 
                                        color={position.size.isPositive() ? 'green' : 'red'}
                                        variant="light"
                                    >
                                        {position.size.isPositive() ? 'Long' : 'Short'}
                                    </Badge>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    {formatNumber(position.size.abs())}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    {formatPrice(position.avgEntryPrice)}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    {formatPrice(position.markPrice)}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    <Text color={pnlColor} weight={500}>
                                        {formatNumber(position.unrealizedPnL)}
                                    </Text>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    <Text color={pnlColor}>
                                        {formatPercent(roe)}
                                    </Text>
                                </td>
                                {!compact && (
                                    <>
                                        <td style={{ textAlign: 'right' }}>
                                            {formatPrice(position.liquidationPrice)}
                                        </td>
                                        <td style={{ textAlign: 'right' }}>
                                            {formatNumber(
                                                position.size.abs().mul(position.markPrice)
                                            )}
                                        </td>
                                    </>
                                )}
                                <td>
                                    <Group position="center" spacing="xs">
                                        <Tooltip label="Position Settings">
                                            <ActionIcon
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedPosition(position);
                                                    setIsSettingsOpen(true);
                                                }}
                                            >
                                                <IconAdjustments size={16} />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label="Close Position">
                                            <ActionIcon
                                                color="red"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleClosePosition(position);
                                                }}
                                            >
                                                <IconX size={16} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Group>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </Table>

            {selectedPosition && (
                <PositionSettingsModal
                    position={selectedPosition}
                    isOpen={isSettingsOpen}
                    onClose={() => {
                        setIsSettingsOpen(false);
                        setSelectedPosition(null);
                    }}
                    onSubmit={handleSettingsUpdate}
                />
            )}
        </>
    );
};
