import React, { useState, useEffect } from 'react';
import {
    AppShell,
    Navbar,
    Header,
    Grid,
    Tabs,
    Group,
    Text,
    Button,
    Menu,
    ActionIcon,
    Modal,
    Stack,
    Select,
    ScrollArea
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
    IconDashboard,
    IconAlertTriangle,
    IconSettings,
    IconRefresh,
    IconDownload,
    IconPlus,
    IconDotsVertical
} from '@tabler/icons-react';
import { SystemStatus } from './SystemStatus';
import { PerformanceMetrics } from './PerformanceMetrics';
import { AlertsList } from './AlertsList';
import { AlertRuleForm } from './AlertRuleForm';
import { useMonitoring } from '../hooks/useMonitoring';
import { useAlerting } from '../hooks/useAlerting';
import { exportMetrics } from '../utils/export';
import { AlertRule } from '../types/monitoring.types';

export const MonitoringDashboard: React.FC = () => {
    const isMobile = useMediaQuery('(max-width: 768px)');
    const { systemHealth, refreshMetrics } = useMonitoring();
    const { 
        alerts, 
        alertRules, 
        addAlertRule, 
        updateAlertRule, 
        deleteAlertRule 
    } = useAlerting();

    const [activeTab, setActiveTab] = useState<string>('overview');
    const [showAddRule, setShowAddRule] = useState(false);
    const [selectedTimeRange, setSelectedTimeRange] = useState<string>('24h');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        refreshMetrics();
        const interval = setInterval(refreshMetrics, 60000); // Refresh every minute
        return () => clearInterval(interval);
    }, []);

    const handleRefresh = async () => {
        setIsLoading(true);
        try {
            await refreshMetrics();
        } finally {
            setIsLoading(false);
        }
    };

    const handleExport = async () => {
        const timeRanges = {
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000
        };

        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - timeRanges[selectedTimeRange]);
        
        await exportMetrics(startDate, endDate);
    };

    const handleAddRule = async (rule: Omit<AlertRule, 'id'>) => {
        try {
            await addAlertRule(rule);
            setShowAddRule(false);
        } catch (error) {
            console.error('Failed to add alert rule:', error);
        }
    };

    return (
        <AppShell
            padding="md"
            navbar={
                !isMobile ? (
                    <Navbar width={{ base: 250 }} p="xs">
                        <Navbar.Section>
                            <Group position="apart" mb="md">
                                <Text size="lg" weight={500}>
                                    Monitoring
                                </Text>
                                <ActionIcon 
                                    loading={isLoading}
                                    onClick={handleRefresh}
                                >
                                    <IconRefresh size={16} />
                                </ActionIcon>
                            </Group>
                        </Navbar.Section>
                        <Navbar.Section grow>
                            <Stack spacing="xs">
                                <Button
                                    variant={activeTab === 'overview' ? 'filled' : 'light'}
                                    leftIcon={<IconDashboard size={16} />}
                                    onClick={() => setActiveTab('overview')}
                                >
                                    Overview
                                </Button>
                                <Button
                                    variant={activeTab === 'alerts' ? 'filled' : 'light'}
                                    leftIcon={<IconAlertTriangle size={16} />}
                                    onClick={() => setActiveTab('alerts')}
                                >
                                    Alerts
                                </Button>
                                <Button
                                    variant={activeTab === 'settings' ? 'filled' : 'light'}
                                    leftIcon={<IconSettings size={16} />}
                                    onClick={() => setActiveTab('settings')}
                                >
                                    Settings
                                </Button>
                            </Stack>
                        </Navbar.Section>
                    </Navbar>
                ) : null
            }
            header={
                <Header height={60} p="xs">
                    <Group position="apart">
                        <Text size="lg" weight={500}>
                            System Monitoring
                        </Text>
                        <Group spacing="xs">
                            <Select
                                size="xs"
                                value={selectedTimeRange}
                                onChange={(value) => setSelectedTimeRange(value)}
                                data={[
                                    { value: '24h', label: 'Last 24 Hours' },
                                    { value: '7d', label: 'Last 7 Days' },
                                    { value: '30d', label: 'Last 30 Days' }
                                ]}
                            />
                            <Button
                                size="xs"
                                leftIcon={<IconDownload size={16} />}
                                onClick={handleExport}
                            >
                                Export
                            </Button>
                            <Menu position="bottom-end">
                                <Menu.Target>
                                    <ActionIcon>
                                        <IconDotsVertical size={16} />
                                    </ActionIcon>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Menu.Item
                                        icon={<IconPlus size={16} />}
                                        onClick={() => setShowAddRule(true)}
                                    >
                                        Add Alert Rule
                                    </Menu.Item>
                                    <Menu.Item
                                        icon={<IconRefresh size={16} />}
                                        onClick={handleRefresh}
                                    >
                                        Refresh Data
                                    </Menu.Item>
                                </Menu.Dropdown>
                            </Menu>
                        </Group>
                    </Group>
                </Header>
            }
        >
            <ScrollArea>
                {activeTab === 'overview' && (
                    <Grid>
                        <Grid.Col span={12}>
                            <SystemStatus />
                        </Grid.Col>
                        <Grid.Col span={12}>
                            <PerformanceMetrics 
                                defaultRange={[
                                    new Date(Date.now() - 24 * 60 * 60 * 1000),
                                    new Date()
                                ]}
                            />
                        </Grid.Col>
                    </Grid>
                )}

                {activeTab === 'alerts' && (
                    <Grid>
                        <Grid.Col span={12}>
                            <Group position="apart" mb="md">
                                <Text size="lg" weight={500}>
                                    Alert Rules
                                </Text>
                                <Button
                                    size="xs"
                                    leftIcon={<IconPlus size={16} />}
                                    onClick={() => setShowAddRule(true)}
                                >
                                    Add Rule
                                </Button>
                            </Group>
                            {alertRules.map(rule => (
                                <AlertRuleItem
                                    key={rule.id}
                                    rule={rule}
                                    onUpdate={updateAlertRule}
                                    onDelete={deleteAlertRule}
                                />
                            ))}
                        </Grid.Col>
                        <Grid.Col span={12}>
                            <Text size="lg" weight={500} mb="md">
                                Active Alerts
                            </Text>
                            <AlertsList alerts={alerts} />
                        </Grid.Col>
                    </Grid>
                )}

                {activeTab === 'settings' && (
                    <Grid>
                        <Grid.Col span={12}>
                            <SystemSettings />
                        </Grid.Col>
                    </Grid>
                )}
            </ScrollArea>

            <Modal
                opened={showAddRule}
                onClose={() => setShowAddRule(false)}
                title="Add Alert Rule"
            >
                <AlertRuleForm onSubmit={handleAddRule} />
            </Modal>
        </AppShell>
    );
};

export default MonitoringDashboard;
