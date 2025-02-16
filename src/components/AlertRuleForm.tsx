import React from 'react';
import {
    Stack,
    TextInput,
    Select,
    NumberInput,
    MultiSelect,
    Button,
    Group,
    Switch,
    Text
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { AlertRule } from '../types/monitoring.types';
import { validateAlertRule } from '../utils/validation';
import { Decimal } from 'decimal.js';

interface AlertRuleFormProps {
    initialValues?: Partial<AlertRule>;
    onSubmit: (values: Partial<AlertRule>) => Promise<void>;
}

export const AlertRuleForm: React.FC<AlertRuleFormProps> = ({
    initialValues = {},
    onSubmit
}) => {
    const form = useForm({
        initialValues: {
            name: '',
            metric: '',
            condition: 'gt',
            threshold: '',
            severity: 'warning',
            duration: 0,
            enabled: true,
            notificationChannels: [],
            ...initialValues
        },
        validate: {
            name: (value) => !value.trim() ? 'Name is required' : null,
            metric: (value) => !value.trim() ? 'Metric is required' : null,
            threshold: (value) => {
                try {
                    if (!value || new Decimal(value).isNaN()) {
                        return 'Valid threshold value is required';
                    }
                    return null;
                } catch {
                    return 'Invalid threshold format';
                }
            },
            duration: (value) => {
                if (value < 0 || value > 86400) {
                    return 'Duration must be between 0 and 86400 seconds';
                }
                return null;
            }
        }
    });

    const handleSubmit = async (values: typeof form.values) => {
        const validation = validateAlertRule(values);
        if (!validation.isValid) {
            validation.errors.forEach(error => {
                form.setFieldError('name', error);
            });
            return;
        }

        try {
            await onSubmit(values);
            form.reset();
        } catch (error) {
            console.error('Failed to submit alert rule:', error);
            form.setFieldError('name', 'Failed to save alert rule');
        }
    };

    return (
        <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack spacing="md">
                <TextInput
                    required
                    label="Rule Name"
                    placeholder="Enter rule name"
                    {...form.getInputProps('name')}
                />

                <TextInput
                    required
                    label="Metric"
                    placeholder="Enter metric name"
                    {...form.getInputProps('metric')}
                />

                <Group grow>
                    <Select
                        required
                        label="Condition"
                        data={[
                            { value: 'gt', label: 'Greater Than' },
                            { value: 'lt', label: 'Less Than' },
                            { value: 'eq', label: 'Equals' },
                            { value: 'gte', label: 'Greater Than or Equal' },
                            { value: 'lte', label: 'Less Than or Equal' }
                        ]}
                        {...form.getInputProps('condition')}
                    />

                    <NumberInput
                        required
                        label="Threshold"
                        placeholder="Enter threshold value"
                        precision={8}
                        {...form.getInputProps('threshold')}
                    />
                </Group>

                <Group grow>
                    <Select
                        required
                        label="Severity"
                        data={[
                            { value: 'info', label: 'Info' },
                            { value: 'warning', label: 'Warning' },
                            { value: 'critical', label: 'Critical' }
                        ]}
                        {...form.getInputProps('severity')}
                    />

                    <NumberInput
                        label="Duration (seconds)"
                        placeholder="0 for immediate"
                        min={0}
                        max={86400}
                        {...form.getInputProps('duration')}
                    />
                </Group>

                <MultiSelect
                    label="Notification Channels"
                    data={[
                        { value: 'email', label: 'Email' },
                        { value: 'slack', label: 'Slack' },
                        { value: 'telegram', label: 'Telegram' }
                    ]}
                    {...form.getInputProps('notificationChannels')}
                />

                <Group position="apart">
                    <Text size="sm">Enable Rule</Text>
                    <Switch
                        {...form.getInputProps('enabled', { type: 'checkbox' })}
                    />
                </Group>

                <Group position="right">
                    <Button type="submit">
                        {initialValues.id ? 'Update Rule' : 'Create Rule'}
                    </Button>
                </Group>
            </Stack>
        </form>
    );
};
