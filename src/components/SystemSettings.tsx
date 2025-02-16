import React, { useState, useEffect } from 'react';
import {
    Paper,
    Stack,
    Group,
    Text,
    Switch,
    NumberInput,
    Select,
    Button,
    Divider,
    TextInput,
    Accordion,
    Alert,
    Code
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMonitoring } from '../hooks/useMonitoring';
import { useNotifications } from '../hooks/useNotifications';
import { ConfigService } from '../services/config/ConfigService';
import { validateConfig } from '../utils/validation';

interface SystemConfig {
    monitoring: {
        interval: number;
        retentionDays: number;
        alertThrottling: number;
    };
    websocket: {
        reconnectAttempts: number;
        reconnectInterval: number;
        pingInterval: number;
    };
    notifications: {
        email: {
            enabled: boolean;
            smtpHost: string;
            smtpPort: number;
            sender: string;
            recipients: string[];
        };
        slack: {
            enabled: boolean;
            webhook: string;
            channel: string;
        };
        telegram: {
            enabled: boolean;
            botToken: string;
            chatId: string;
        };
    };
    logging: {
        level: 'debug' | 'info' | 'warn' | 'error';
        retention: number;
        maxSize: number;
    };
}

export const SystemSettings: React.FC = () => {
    const { updateSystemConfig, getSystemConfig } = useMonitoring();
    const { showNotification } = useNotifications();
    const [config, setConfig] = useState<SystemConfig>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [hasChanges, setHasChanges] = useState(false);

    useEffect(() => {
        loadConfig();
    }, []);

    const loadConfig = async () => {
        try {
            const currentConfig = await getSystemConfig();
            setConfig(currentConfig);
        } catch (error) {
            showNotification({
                title: 'Error',
                message: 'Failed to load system configuration',
                color: 'red'
            });
        }
    };

    const handleSave = async () => {
        try {
            setIsLoading(true);
            const validationResult = validateConfig(config);
            
            if (!validationResult.isValid) {
                showNotification({
                    title: 'Validation Error',
                    message: validationResult.errors.join('\n'),
                    color: 'red'
                });
                return;
            }

            await updateSystemConfig(config);
            setHasChanges(false);
            showNotification({
                title: 'Success',
                message: 'System configuration updated successfully',
                color: 'green'
            });
        } catch (error) {
            showNotification({
                title: 'Error',
                message: 'Failed to update system configuration',
                color: 'red'
            });
        } finally {
            setIsLoading(false);
        }
    };

    const updateConfig = (path: string[], value: any) => {
        setConfig(prev => {
            const newConfig = { ...prev };
            let current = newConfig;
            for (let i = 0; i < path.length - 1; i++) {
                current = current[path[i]];
            }
            current[path[path.length - 1]] = value;
            return newConfig;
        });
        setHasChanges(true);
    };

    if (!config) return null;

    return (
        <Paper p="md">
            <Stack spacing="lg">
                <Group position="apart">
                    <Text size="xl" weight={500}>System Settings</Text>
                    <Button
                        loading={isLoading}
                        disabled={!hasChanges}
                        onClick={handleSave}
                    >
                        Save Changes
                    </Button>
                </Group>

                <Accordion>
                    <Accordion.Item value="monitoring">
                        <Accordion.Control>Monitoring Configuration</Accordion.Control>
                        <Accordion.Panel>
                            <Stack spacing="md">
                                <NumberInput
                                    label="Monitoring Interval (ms)"
                                    value={config.monitoring.interval}
                                    onChange={(value) => updateConfig(['monitoring', 'interval'], value)}
                                    min={1000}
                                    max={60000}
                                />
                                <NumberInput
                                    label="Data Retention (days)"
                                    value={config.monitoring.retentionDays}
                                    onChange={(value) => updateConfig(['monitoring', 'retentionDays'], value)}
                                    min={1}
                                    max={365}
                                />
                                <NumberInput
                                    label="Alert Throttling (seconds)"
                                    value={config.monitoring.alertThrottling}
                                    onChange={(value) => updateConfig(['monitoring', 'alertThrottling'], value)}
                                    min={0}
                                    max={3600}
                                />
                            </Stack>
                        </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="websocket">
                        <Accordion.Control>WebSocket Settings</Accordion.Control>
                        <Accordion.Panel>
                            <Stack spacing="md">
                                <NumberInput
                                    label="Reconnect Attempts"
                                    value={config.websocket.reconnectAttempts}
                                    onChange={(value) => updateConfig(['websocket', 'reconnectAttempts'], value)}
                                    min={1}
                                    max={10}
                                />
                                <NumberInput
                                    label="Reconnect Interval (ms)"
                                    value={config.websocket.reconnectInterval}
                                    onChange={(value) => updateConfig(['websocket', 'reconnectInterval'], value)}
                                    min={1000}
                                    max={30000}
                                />
                                <NumberInput
                                    label="Ping Interval (ms)"
                                    value={config.websocket.pingInterval}
                                    onChange={(value) => updateConfig(['websocket', 'pingInterval'], value)}
                                    min={5000}
                                    max={60000}
                                />
                            </Stack>
                        </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="notifications">
                        <Accordion.Control>Notification Settings</Accordion.Control>
                        <Accordion.Panel>
                            <Stack spacing="xl">
                                <Stack spacing="md">
                                    <Group position="apart">
                                        <Text weight={500}>Email Notifications</Text>
                                        <Switch
                                            checked={config.notifications.email.enabled}
                                            onChange={(event) => updateConfig(
                                                ['notifications', 'email', 'enabled'],
                                                event.currentTarget.checked
                                            )}
                                        />
                                    </Group>
                                    {config.notifications.email.enabled && (
                                        <>
                                            <TextInput
                                                label="SMTP Host"
                                                value={config.notifications.email.smtpHost}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'email', 'smtpHost'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                            <NumberInput
                                                label="SMTP Port"
                                                value={config.notifications.email.smtpPort}
                                                onChange={(value) => updateConfig(
                                                    ['notifications', 'email', 'smtpPort'],
                                                    value
                                                )}
                                                min={1}
                                                max={65535}
                                            />
                                            <TextInput
                                                label="Sender Email"
                                                value={config.notifications.email.sender}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'email', 'sender'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                        </>
                                    )}
                                </Stack>

                                <Divider />

                                <Stack spacing="md">
                                    <Group position="apart">
                                        <Text weight={500}>Slack Notifications</Text>
                                        <Switch
                                            checked={config.notifications.slack.enabled}
                                            onChange={(event) => updateConfig(
                                                ['notifications', 'slack', 'enabled'],
                                                event.currentTarget.checked
                                            )}
                                        />
                                    </Group>
                                    {config.notifications.slack.enabled && (
                                        <>
                                            <TextInput
                                                label="Webhook URL"
                                                value={config.notifications.slack.webhook}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'slack', 'webhook'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                            <TextInput
                                                label="Channel"
                                                value={config.notifications.slack.channel}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'slack', 'channel'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                        </>
                                    )}
                                </Stack>

                                <Divider />

                                <Stack spacing="md">
                                    <Group position="apart">
                                        <Text weight={500}>Telegram Notifications</Text>
                                        <Switch
                                            checked={config.notifications.telegram.enabled}
                                            onChange={(event) => updateConfig(
                                                ['notifications', 'telegram', 'enabled'],
                                                event.currentTarget.checked
                                            )}
                                        />
                                    </Group>
                                    {config.notifications.telegram.enabled && (
                                        <>
                                            <TextInput
                                                label="Bot Token"
                                                value={config.notifications.telegram.botToken}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'telegram', 'botToken'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                            <TextInput
                                                label="Chat ID"
                                                value={config.notifications.telegram.chatId}
                                                onChange={(event) => updateConfig(
                                                    ['notifications', 'telegram', 'chatId'],
                                                    event.currentTarget.value
                                                )}
                                            />
                                        </>
                                    )}
                                </Stack>
                            </Stack>
                        </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="logging">
                        <Accordion.Control>Logging Configuration</Accordion.Control>
                        <Accordion.Panel>
                            <Stack spacing="md">
                                <Select
                                    label="Log Level"
                                    value={config.logging.level}
                                    onChange={(value) => updateConfig(['logging', 'level'], value)}
                                    data={[
                                        { value: 'debug', label: 'Debug' },
                                        { value: 'info', label: 'Info' },
                                        { value: 'warn', label: 'Warning' },
                                        { value: 'error', label: 'Error' }
                                    ]}
                                />
                                <NumberInput
                                    label="Log Retention (days)"
                                    value={config.logging.retention}
                                    onChange={(value) => updateConfig(['logging', 'retention'], value)}
                                    min={1}
                                    max={365}
                                />
                                <NumberInput
                                    label="Max Log Size (MB)"
                                    value={config.logging.maxSize}
                                    onChange={(value) => updateConfig(['logging', 'maxSize'], value)}
                                    min={1}
                                    max={1000}
                                />
                            </Stack>
                        </Accordion.Panel>
                    </Accordion.Item>
                </Accordion>

                {hasChanges && (
                    <Alert icon={<IconAlertCircle size={16} />} color="blue">
                        You have unsaved changes. Click the Save Changes button to apply them.
                    </Alert>
                )}
            </Stack>
        </Paper>
    );
};
