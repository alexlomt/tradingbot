import React from 'react';
import {
    Box,
    Grid,
    Typography,
    LinearProgress,
    Tooltip,
    IconButton
} from '@mui/material';
import {
    Memory,
    Storage,
    NetworkCheck,
    CloudQueue,
    Warning
} from '@mui/icons-material';
import { SystemHealth, ResourceStatus } from '../../../types/monitoring.types';
import { formatBytes, formatNumber } from '../../../utils/formatters';

interface SystemHealthPanelProps {
    data: SystemHealth;
}

export const SystemHealthPanel: React.FC<SystemHealthPanelProps> = ({ data }) => {
    const getStatusColor = (status: ResourceStatus) => {
        switch (status) {
            case 'healthy':
                return 'success.main';
            case 'warning':
                return 'warning.main';
            case 'critical':
                return 'error.main';
            default:
                return 'grey.500';
        }
    };

    const renderResourceMetric = (
        icon: React.ReactNode,
        title: string,
        value: number,
        total: number,
        unit: string,
        status: ResourceStatus
    ) => (
        <Box sx={{ mb: 2 }}>
            <Box display="flex" alignItems="center" mb={1}>
                {icon}
                <Typography variant="subtitle1" ml={1}>
                    {title}
                </Typography>
                {status === 'warning' || status === 'critical' ? (
                    <Tooltip title={`${status.toUpperCase()}: High usage detected`}>
                        <IconButton size="small" color="warning">
                            <Warning />
                        </IconButton>
                    </Tooltip>
                ) : null}
            </Box>
            <Box display="flex" alignItems="center" mb={0.5}>
                <Typography variant="body2" color="textSecondary">
                    {formatNumber(value, unit)} / {formatNumber(total, unit)}
                </Typography>
                <Typography variant="body2" color="textSecondary" ml={1}>
                    ({((value / total) * 100).toFixed(1)}%)
                </Typography>
            </Box>
            <LinearProgress
                variant="determinate"
                value={(value / total) * 100}
                sx={{
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: 'action.hover',
                    '& .MuiLinearProgress-bar': {
                        backgroundColor: getStatusColor(status)
                    }
                }}
            />
        </Box>
    );

    return (
        <Box>
            <Typography variant="h6" gutterBottom>
                System Health
            </Typography>
            <Grid container spacing={3}>
                <Grid item xs={12} md={6}>
                    {renderResourceMetric(
                        <Memory color="primary" />,
                        'Memory Usage',
                        data.memory.used,
                        data.memory.total,
                        'MB',
                        data.memory.status
                    )}
                    {renderResourceMetric(
                        <Storage color="primary" />,
                        'Disk Usage',
                        data.disk.used,
                        data.disk.total,
                        'GB',
                        data.disk.status
                    )}
                </Grid>
                <Grid item xs={12} md={6}>
                    {renderResourceMetric(
                        <NetworkCheck color="primary" />,
                        'Network Bandwidth',
                        data.network.bandwidth,
                        data.network.capacity,
                        'Mbps',
                        data.network.status
                    )}
                    {renderResourceMetric(
                        <CloudQueue color="primary" />,
                        'API Response Time',
                        data.api.responseTime,
                        data.api.threshold,
                        'ms',
                        data.api.status
                    )}
                </Grid>
                <Grid item xs={12}>
                    <Box mt={2}>
                        <Typography variant="subtitle2" gutterBottom>
                            System Uptime
                        </Typography>
                        <Typography variant="h4">
                            {formatUptime(data.uptime)}
                        </Typography>
                    </Box>
                </Grid>
            </Grid>
        </Box>
    );
};

const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || '0m';
};
