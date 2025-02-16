import React, { useState, useEffect } from 'react';
import { 
    Paper, 
    Tabs, 
    Group, 
    NumberInput, 
    Select, 
    Button, 
    Slider, 
    Text, 
    Stack,
    SegmentedControl,
    Switch,
    Collapse,
    ActionIcon,
    Tooltip
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAdjustments, IconChartBar, IconLock } from '@tabler/icons-react';
import { useTrading } from '../hooks/useTrading';
import { useMarketData } from '../hooks/useMarketData';
import { OrderSide, OrderType, TimeInForce } from '../types/order.types';
import { Decimal } from 'decimal.js';
import { calculateMarginRequirement } from '../utils/margin';
import { formatNumber, formatPrice } from '../utils/formatters';

interface TradingControlsProps {
    market: string;
    onOrderSubmit?: () => void;
}

export const TradingControls: React.FC<TradingControlsProps> = ({
    market,
    onOrderSubmit
}) => {
    const { 
        createOrder, 
        getAvailableBalance,
        getMarketLeverage
    } = useTrading();
    
    const { 
        getLastPrice,
        getBestBidAsk,
        subscribeToTicker
    } = useMarketData();

    const [activeTab, setActiveTab] = useState<'limit' | 'market'>('limit');
    const [advancedMode, setAdvancedMode] = useState(false);
    const [availableBalance, setAvailableBalance] = useState<Decimal>(new Decimal(0));
    const [maxLeverage, setMaxLeverage] = useState<Decimal>(new Decimal(10));
    const [bestBidAsk, setBestBidAsk] = useState<{ bid: Decimal; ask: Decimal }>({
        bid: new Decimal(0),
        ask: new Decimal(0)
    });

    const form = useForm({
        initialValues: {
            side: OrderSide.BUY,
            type: OrderType.LIMIT,
            price: '',
            size: '',
            leverage: 1,
            postOnly: false,
            reduceOnly: false,
            timeInForce: TimeInForce.GTC,
            stopLoss: '',
            takeProfit: ''
        },
        validate: {
            price: (value) => activeTab === 'market' ? null : 
                !value ? 'Price is required' : null,
            size: (value) => !value ? 'Size is required' : null,
            stopLoss: (value) => {
                if (!value) return null;
                const price = new Decimal(form.values.price || bestBidAsk.ask);
                const side = form.values.side;
                const sl = new Decimal(value);
                if (side === OrderSide.BUY && sl.gte(price)) {
                    return 'Stop loss must be below entry price for longs';
                }
                if (side === OrderSide.SELL && sl.lte(price)) {
                    return 'Stop loss must be above entry price for shorts';
                }
                return null;
            },
            takeProfit: (value) => {
                if (!value) return null;
                const price = new Decimal(form.values.price || bestBidAsk.bid);
                const side = form.values.side;
                const tp = new Decimal(value);
                if (side === OrderSide.BUY && tp.lte(price)) {
                    return 'Take profit must be above entry price for longs';
                }
                if (side === OrderSide.SELL && tp.gte(price)) {
                    return 'Take profit must be below entry price for shorts';
                }
                return null;
            }
        }
    });

    useEffect(() => {
        const updateData = async () => {
            const [balance, leverage, ticker] = await Promise.all([
                getAvailableBalance(),
                getMarketLeverage(market),
                getBestBidAsk(market)
            ]);
            setAvailableBalance(balance);
            setMaxLeverage(leverage);
            setBestBidAsk(ticker);
        };
        updateData();

        const unsubscribe = subscribeToTicker(market, (ticker) => {
            setBestBidAsk(ticker);
        });

        return () => unsubscribe();
    }, [market]);

    const handleSubmit = async (values: typeof form.values) => {
        try {
            const orderSize = new Decimal(values.size);
            const orderPrice = activeTab === 'market' ? 
                (values.side === OrderSide.BUY ? bestBidAsk.ask : bestBidAsk.bid) :
                new Decimal(values.price);

            const order = await createOrder({
                market,
                side: values.side,
                type: activeTab === 'market' ? OrderType.MARKET : OrderType.LIMIT,
                size: orderSize,
                price: orderPrice,
                leverage: values.leverage,
                postOnly: values.postOnly,
                reduceOnly: values.reduceOnly,
                timeInForce: values.timeInForce,
                stopLoss: values.stopLoss ? new Decimal(values.stopLoss) : undefined,
                takeProfit: values.takeProfit ? new Decimal(values.takeProfit) : undefined
            });

            form.reset();
            onOrderSubmit?.();
        } catch (error) {
            console.error('Order submission failed:', error);
        }
    };

    const calculateMaxSize = () => {
        const price = activeTab === 'market' ?
            (form.values.side === OrderSide.BUY ? bestBidAsk.ask : bestBidAsk.bid) :
            new Decimal(form.values.price || 0);

        if (price.isZero()) return new Decimal(0);

        const marginReq = calculateMarginRequirement(
            price,
            new Decimal(1),
            new Decimal(form.values.leverage)
        );

        return availableBalance.div(marginReq);
    };

    return (
        <Paper p="md" radius="md">
            <form onSubmit={form.onSubmit(handleSubmit)}>
                <Stack spacing="md">
                    <SegmentedControl
                        value={form.values.side}
                        onChange={(value) => form.setFieldValue('side', value)}
                        data={[
                            { label: 'Buy/Long', value: OrderSide.BUY },
                            { label: 'Sell/Short', value: OrderSide.SELL }
                        ]}
                        fullWidth
                        color={form.values.side === OrderSide.BUY ? 'green' : 'red'}
                    />

                    <Tabs
                        value={activeTab}
                        onTabChange={(value) => setActiveTab(value as 'limit' | 'market')}
                    >
                        <Tabs.List grow>
                            <Tabs.Tab value="limit">Limit</Tabs.Tab>
                            <Tabs.Tab value="market">Market</Tabs.Tab>
                        </Tabs.List>
                    </Tabs>

                    {activeTab === 'limit' && (
                        <NumberInput
                            label="Price"
                            placeholder="Enter price"
                            precision={8}
                            min={0}
                            step={0.00000001}
                            {...form.getInputProps('price')}
                            rightSection={
                                <Group spacing={5}>
                                    <ActionIcon 
                                        size="sm"
                                        onClick={() => form.setFieldValue(
                                            'price',
                                            form.values.side === OrderSide.BUY ? 
                                                bestBidAsk.bid.toString() :
                                                bestBidAsk.ask.toString()
                                        )}
                                    >
                                        <IconChartBar size={14} />
                                    </ActionIcon>
                                </Group>
                            }
                        />
                    )}

                    <NumberInput
                        label="Size"
                        placeholder="Enter size"
                        precision={8}
                        min={0}
                        step={0.00000001}
                        {...form.getInputProps('size')}
                        rightSection={
                            <Group spacing={5}>
                                <ActionIcon 
                                    size="sm"
                                    onClick={() => form.setFieldValue(
                                        'size',
                                        calculateMaxSize().toString()
                                    )}
                                >
                                    <IconLock size={14} />
                                </ActionIcon>
                            </Group>
                        }
                    />

                    <Group grow>
                        <NumberInput
                            label="Leverage"
                            value={form.values.leverage}
                            onChange={(value) => form.setFieldValue('leverage', value)}
                            min={1}
                            max={maxLeverage.toNumber()}
                            step={1}
                        />
                        <Slider
                            value={form.values.leverage}
                            onChange={(value) => form.setFieldValue('leverage', value)}
                            min={1}
                            max={maxLeverage.toNumber()}
                            label={(value) => `${value}x`}
                            style={{ flexGrow: 1 }}
                        />
                    </Group>

                    <Group position="right">
                        <Switch
                            label="Advanced Mode"
                            checked={advancedMode}
                            onChange={(event) => setAdvancedMode(event.currentTarget.checked)}
                        />
                    </Group>

                    <Collapse in={advancedMode}>
                        <Stack spacing="sm">
                            <Select
                                label="Time In Force"
                                data={[
                                    { label: 'Good Till Cancel', value: TimeInForce.GTC },
                                    { label: 'Immediate or Cancel', value: TimeInForce.IOC },
                                    { label: 'Fill or Kill', value: TimeInForce.FOK }
                                ]}
                                {...form.getInputProps('timeInForce')}
                            />

                            <Group grow>
                                <NumberInput
                                    label="Stop Loss"
                                    placeholder="Optional"
                                    precision={8}
                                    {...form.getInputProps('stopLoss')}
                                />
                                <NumberInput
                                    label="Take Profit"
                                    placeholder="Optional"
                                    precision={8}
                                    {...form.getInputProps('takeProfit')}
                                />
                            </Group>

                            <Group>
                                <Switch
                                    label="Post Only"
                                    {...form.getInputProps('postOnly', { type: 'checkbox' })}
                                />
                                <Switch
                                    label="Reduce Only"
                                    {...form.getInputProps('reduceOnly', { type: 'checkbox' })}
                                />
                            </Group>
                        </Stack>
                    </Collapse>

                    <Button
                        type="submit"
                        fullWidth
                        size="lg"
                        color={form.values.side === OrderSide.BUY ? 'green' : 'red'}
                    >
                        {form.values.side === OrderSide.BUY ? 'Buy/Long' : 'Sell/Short'} {market}
                    </Button>
                </Stack>
            </form>
        </Paper>
    );
};
