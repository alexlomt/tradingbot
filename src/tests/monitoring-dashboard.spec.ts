import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MonitoringDashboard } from '../components/MonitoringDashboard';
import { MonitoringProvider } from '../providers/MonitoringProvider';
import { AlertingProvider } from '../providers/AlertingProvider';
import { NotificationProvider } from '../providers/NotificationProvider';
import { AlertRule, SystemHealth } from '../types/monitoring.types';
import { Decimal } from 'decimal.js';
import '@testing-library/jest-dom';

jest.mock('../hooks/useMonitoring', () => ({
    useMonitoring: () => ({
        systemHealth: mockSystemHealth,
        refreshMetrics: jest.fn(),
        getHistoricalMetrics: jest.fn().resolving(mockHistoricalMetrics)
    })
}));

const mockSystemHealth: SystemHealth = {
    status: 'healthy',
    components: {
        websocket: {
            status: 'up',
            latency: 50,
            errorRate: new Decimal('0.001'),
            lastCheck: new Date('2025-02-16T02:31:20Z')
        },
        database: {
            status: 'up',
            latency: 20,
            errorRate: new Decimal('0'),
            lastCheck: new Date('2025-02-16T02:31:20Z')
        }
    },
    metrics: {
        cpuUsage: new Decimal('45.5'),
        memoryUsage: new Decimal('60.2'),
        wsLatency: 50,
        activeConnections: 100,
        queueSize: 50
    }
};

const mockAlertRules: AlertRule[] = [
    {
        id: 'rule1',
        name: 'High CPU Usage',
        metric: 'cpu_usage',
        condition: 'gt',
        threshold: new Decimal('80'),
        severity: 'warning',
        duration: 300,
        enabled: true,
        notificationChannels: ['email']
    }
];

describe('MonitoringDashboard', () => {
    const renderDashboard = () => {
        return render(
            <NotificationProvider>
                <MonitoringProvider>
                    <AlertingProvider>
                        <MonitoringDashboard />
                    </AlertingProvider>
                </MonitoringProvider>
            </NotificationProvider>
        );
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renders system status section', async () => {
        renderDashboard();

        expect(screen.getByText('System Status')).toBeInTheDocument();
        expect(screen.getByText('CPU')).toBeInTheDocument();
        expect(screen.getByText('Memory')).toBeInTheDocument();

        await waitFor(() => {
            expect(screen.getByText('45.5%')).toBeInTheDocument();
            expect(screen.getByText('60.2%')).toBeInTheDocument();
        });
    });

    it('handles tab navigation', async () => {
        renderDashboard();

        const alertsTab = screen.getByRole('tab', { name: /alerts/i });
        await userEvent.click(alertsTab);

        expect(screen.getByText('Alert Rules')).toBeInTheDocument();
        
        const settingsTab = screen.getByRole('tab', { name: /settings/i });
        await userEvent.click(settingsTab);

        expect(screen.getByText('System Settings')).toBeInTheDocument();
    });

    it('allows adding new alert rules', async () => {
        renderDashboard();

        const addButton = screen.getByRole('button', { name: /add rule/i });
        await userEvent.click(addButton);

        expect(screen.getByText('Add Alert Rule')).toBeInTheDocument();

        await userEvent.type(screen.getByLabelText(/rule name/i), 'New Test Rule');
        await userEvent.type(screen.getByLabelText(/metric/i), 'test_metric');
        await userEvent.type(screen.getByLabelText(/threshold/i), '90');

        const submitButton = screen.getByRole('button', { name: /create rule/i });
        await userEvent.click(submitButton);

        await waitFor(() => {
            expect(screen.queryByText('Add Alert Rule')).not.toBeInTheDocument();
        });
    });

    it('handles data export', async () => {
        renderDashboard();

        const exportButton = screen.getByRole('button', { name: /export/i });
        await userEvent.click(exportButton);

        const timeRangeSelect = screen.getByRole('combobox');
        await userEvent.selectOptions(timeRangeSelect, '7d');

        await waitFor(() => {
            expect(screen.getByText('Export in progress...')).toBeInTheDocument();
        });
    });

    it('displays real-time updates', async () => {
        renderDashboard();

        const refreshButton = screen.getByRole('button', { name: /refresh/i });
        await userEvent.click(refreshButton);

        await waitFor(() => {
            expect(screen.getByText('Data refreshed')).toBeInTheDocument();
        });
    });

    it('handles error states gracefully', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        
        renderDashboard();

        // Simulate error state
        await waitFor(() => {
            expect(screen.getByText('Error loading data')).toBeInTheDocument();
        });

        const retryButton = screen.getByRole('button', { name: /retry/i });
        await userEvent.click(retryButton);

        await waitFor(() => {
            expect(screen.queryByText('Error loading data')).not.toBeInTheDocument();
        });
    });
});
