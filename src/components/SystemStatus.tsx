import React, { useEffect, useState } from 'react';
import {
    Paper,
    Group,
    Stack,
    Text,
    RingProgress,
    Badge,
    ThemeIcon,
    Tooltip,
    Timeline,
    Collapse,
    ActionIcon
} from '@mantine/core';
import { 
    IconServer, 
    IconDatabase, 
    IconWifi, 
    IconCpu, 
    IconAlertTriangle,
    IconCheck,
    IconX,
    IconChevronDown,
    IconChevronUp
} from '@tabler/icons-react';
import { useMonitoring } from '../hooks/useMonitoring';
import { formatNumber, formatDuration } from '../utils/formatters';
import { Decimal } from 'decimal.js';
import { SystemHealth } from '../types/monitoring.types';

interface SystemStatusProps {
    compact?: boolean;
    showDetails?: boolean;
}

export const SystemStatus: React.FC<SystemStatusProps> = ({
    compact = false,
    showDetails = true
}) => {
    const { systemHealth, systemEvents } = useMonitoring();
    const [expanded, setExpanded] = useState(!compact);
    const [health, setHealth] = useState<SystemHealth | null>(null);

    useEffect(() => {
        const subscription = systemHealth.subscribe(
            newHealth => setHealth(newHealth)
        );
        return () => subscription.unsubscribe();
    }, []);

    if (!health) return null;

    const getStatusColor = (status: string): string => {
        switch (status) {
            case 'healthy':
            case 'up':
                return 'green';
            case 'degraded':
                return 'yellow';
            case 'critical':
            case 'down':
                return 'red';
            default:
                return 'gray';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'healthy':
            case 'up':
                return <IconCheck size={16} />;
            case 'degraded':
                return <IconAlertTriangle size={16} />;
            case 'critical':
            case 'down':
                return <IconX size={16} />;
            default:
                return null;
        }
    };

    const getComponentIcon = (component: string) => {
        switch (component) {
            case 'websocket':
                return <IconWifi size={20} />;
            case 'database':
                return <IconDatabase size={20} />;
            case 'marketData':
                return <IconServer size={20} />;
            case 'execution':
                return <IconCpu size={20} />;
            default:
                return null;
        }
    };

    return (
        <Paper p="md" radius="md">
            <Stack spacing="md">
                <Group position="apart">
                    <Group spacing="xs">
                        <ThemeIcon 
                            color={getStatusColor(health.status)}
                            variant="light"
                            size="md"
                        >
                            {getStatusIcon(health.status)}
                        </ThemeIcon>
                        <Text size="lg" weight={500}>
                            System Status
                        </Text>
                    </Group>
                    {!compact && (
                        <ActionIcon onClick={() => setExpanded(!expanded)}>
                            {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
                        </ActionIcon>
                    )}
                </Group>

                <Group grow>
                    <RingProgress
                        sections={[
                            { 
                                value: health.metrics.cpuUsage.mul(100).toNumber(), 
                                color: health.metrics.cpuUsage.gt(0.8) ? 'red' : 'blue'
                            }
                        ]}
                        label={
                            <Text size="xs" align="center">
                                CPU
                            </Text>
                        }
                    />
                    <RingProgress
                        sections={[
                            {
                                value: health.metrics.memoryUsage.mul(100).toNumber(),
                                color: health.metrics.memoryUsage.gt(0.85) ? 'red' : 'green'
                            }
                        ]}
                        label={
                            <Text size="xs" align="center">
                                Memory
                            </Text>
                        }
                    />
                </Group>

                <Collapse in={expanded}>
                    <Stack spacing="sm">
                        {Object.entries(health.components).map(([name, component]) => (
                            <Paper key={name} p="xs" withBorder>
                                <Group position="apart">
                                    <Group spacing="xs">
                                        {getComponentIcon(name)}
                                        <Text size="sm">{name}</Text>
                                    </Group>
                                    <Group spacing="xs">
                                        <Tooltip
                                            label={`Latency: ${formatDuration(component.latency)}
                                                   Error Rate: ${formatNumber(component.errorRate)}%`}
                                        >
                                            <Badge 
                                                color={getStatusColor(component.status)}
                                                variant="dot"
                                            >
                                                {component.status}
                                            </Badge>
                                        </Tooltip>
                                    </Group>
                                </Group>
                            </Paper>
                        ))}

                        {showDetails && systemEvents.length > 0 && (
                            <Timeline active={systemEvents.length - 1} bulletSize={24} lineWidth={2}>
                                {systemEvents.slice(-5).map((event, index) => (
                                    <Timeline.Item
                                        key={index}
                                        bullet={getStatusIcon(event.severity)}
                                        title={event.event}
                                    >
                                        <Text color="dimmed" size="sm">
                                            {event.message}
                                        </Text>
                                        <Text size="xs" mt={4}>
                                            {new Date(event.timestamp).toLocaleTimeString()}
                                        </Text>
                                    </Timeline.Item>
                                ))}
                            </Timeline>
                        )}
                    </Stack>
                </Collapse>
            </Stack>
        </Paper>
    );
};
