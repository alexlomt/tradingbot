import React, { useEffect, useState } from 'react';
import { 
    Paper, 
    Text, 
    Group, 
    Stack, 
    Badge, 
    ActionIcon, 
    ScrollArea,
    Transition,
    useMantineTheme
} from '@mantine/core';
import { useSubscription, useQuery } from '@apollo/client';
import { IconX, IconBell, IconAlertTriangle } from '@tabler/icons-react';
import { GET_ALERTS, SUBSCRIBE_TO_ALERTS } from '../graphql/queries';
import { formatTime } from '../utils/formatters';
import { useNotifications } from '../hooks/useNotifications';
import { Alert, AlertSeverity } from '../types/alert.types';

interface AlertsListProps {
    maxHeight?: number;
    onAlertClick?: (alert: Alert) => void;
}

export const AlertsList: React.FC<AlertsListProps> = ({
    maxHeight = 400,
    onAlertClick
}) => {
    const theme = useMantineTheme();
    const { dismissAlert } = useNotifications();
    const [alerts, setAlerts] = useState<Alert[]>([]);
    const [newAlertIds, setNewAlertIds] = useState<Set<string>>(new Set());

    const { loading, error } = useQuery(GET_ALERTS, {
        onCompleted: (data) => {
            setAlerts(data.alerts);
        }
    });

    const { data: realtimeData } = useSubscription(SUBSCRIBE_TO_ALERTS);

    useEffect(() => {
        if (realtimeData?.alert) {
            const newAlert = realtimeData.alert;
            setAlerts(prev => [newAlert, ...prev]);
            setNewAlertIds(prev => new Set(prev).add(newAlert.id));
            
            setTimeout(() => {
                setNewAlertIds(prev => {
                    const updated = new Set(prev);
                    updated.delete(newAlert.id);
                    return updated;
                });
            }, 3000);
        }
    }, [realtimeData]);

    const handleDismiss = async (alertId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await dismissAlert(alertId);
            setAlerts(prev => prev.filter(a => a.id !== alertId));
        } catch (error) {
            console.error('Failed to dismiss alert:', error);
        }
    };

    const getSeverityColor = (severity: AlertSeverity): string => {
        switch (severity) {
            case 'critical':
                return theme.colors.red[6];
            case 'warning':
                return theme.colors.yellow[6];
            case 'info':
                return theme.colors.blue[6];
            default:
                return theme.colors.gray[6];
        }
    };

    const getSeverityIcon = (severity: AlertSeverity) => {
        switch (severity) {
            case 'critical':
                return <IconAlertTriangle size={16} />;
            case 'warning':
                return <IconBell size={16} />;
            default:
                return <IconBell size={16} />;
        }
    };

    if (error) {
        return <Text color="red">Error loading alerts: {error.message}</Text>;
    }

    return (
        <ScrollArea style={{ height: maxHeight }}>
            <Stack spacing="xs">
                {alerts.map((alert) => (
                    <Transition
                        key={alert.id}
                        mounted={true}
                        transition="slide-right"
                        duration={400}
                    >
                        {(styles) => (
                            <Paper
                                p="sm"
                                shadow="xs"
                                style={{
                                    ...styles,
                                    borderLeft: `4px solid ${getSeverityColor(alert.severity)}`,
                                    backgroundColor: newAlertIds.has(alert.id) 
                                        ? theme.fn.rgba(getSeverityColor(alert.severity), 0.1)
                                        : undefined,
                                    cursor: onAlertClick ? 'pointer' : 'default'
                                }}
                                onClick={() => onAlertClick?.(alert)}
                            >
                                <Group position="apart" align="flex-start">
                                    <Group spacing="sm">
                                        {getSeverityIcon(alert.severity)}
                                        <div>
                                            <Text size="sm" weight={500}>
                                                {alert.title}
                                            </Text>
                                            <Text size="xs" color="dimmed">
                                                {alert.message}
                                            </Text>
                                        </div>
                                    </Group>
                                    <Group spacing="xs">
                                        <Badge 
                                            size="sm"
                                            variant="outline"
                                            color={alert.severity === 'critical' ? 'red' : 'gray'}
                                        >
                                            {formatTime(alert.timestamp)}
                                        </Badge>
                                        <ActionIcon
                                            size="sm"
                                            onClick={(e) => handleDismiss(alert.id, e)}
                                        >
                                            <IconX size={14} />
                                        </ActionIcon>
                                    </Group>
                                </Group>
                                {alert.details && (
                                    <Text 
                                        size="xs" 
                                        color="dimmed" 
                                        mt="xs"
                                        sx={{ 
                                            wordBreak: 'break-word',
                                            whiteSpace: 'pre-wrap'
                                        }}
                                    >
                                        {alert.details}
                                    </Text>
                                )}
                            </Paper>
                        )}
                    </Transition>
                ))}
            </Stack>
        </ScrollArea>
    );
};
