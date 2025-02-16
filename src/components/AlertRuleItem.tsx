import React, { useState } from 'react';
import {
    Paper,
    Group,
    Text,
    Badge,
    ActionIcon,
    Menu,
    Modal,
    Switch,
    Tooltip,
    ThemeIcon
} from '@mantine/core';
import { 
    IconDots,
    IconEdit,
    IconTrash,
    IconCheck,
    IconX,
    IconAlertTriangle,
    IconBellRinging
} from '@tabler/icons-react';
import { AlertRule } from '../types/monitoring.types';
import { AlertRuleForm } from './AlertRuleForm';
import { formatNumber } from '../utils/formatters';
import { Decimal } from 'decimal.js';

interface AlertRuleItemProps {
    rule: AlertRule;
    onUpdate: (id: string, updates: Partial<AlertRule>) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
}

export const AlertRuleItem: React.FC<AlertRuleItemProps> = ({
    rule,
    onUpdate,
    onDelete
}) => {
    const [showEdit, setShowEdit] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isToggling, setIsToggling] = useState(false);

    const handleToggleEnabled = async () => {
        try {
            setIsToggling(true);
            await onUpdate(rule.id, { enabled: !rule.enabled });
        } finally {
            setIsToggling(false);
        }
    };

    const handleUpdate = async (updates: Partial<AlertRule>) => {
        try {
            await onUpdate(rule.id, updates);
            setShowEdit(false);
        } catch (error) {
            console.error('Failed to update alert rule:', error);
        }
    };

    const handleDelete = async () => {
        try {
            setIsDeleting(true);
            await onDelete(rule.id);
        } catch (error) {
            console.error('Failed to delete alert rule:', error);
        }
    };

    const getConditionText = () => {
        const conditions = {
            gt: '>',
            lt: '<',
            eq: '=',
            gte: '≥',
            lte: '≤'
        };
        return conditions[rule.condition] || rule.condition;
    };

    const getSeverityColor = () => {
        switch (rule.severity) {
            case 'critical':
                return 'red';
            case 'warning':
                return 'yellow';
            case 'info':
                return 'blue';
            default:
                return 'gray';
        }
    };

    return (
        <>
            <Paper p="sm" withBorder mb="xs">
                <Group position="apart" noWrap>
                    <Group spacing="xs" noWrap>
                        <ThemeIcon 
                            color={getSeverityColor()} 
                            variant="light"
                            size="md"
                        >
                            <IconAlertTriangle size={16} />
                        </ThemeIcon>
                        <div>
                            <Text size="sm" weight={500}>
                                {rule.name}
                            </Text>
                            <Text size="xs" color="dimmed">
                                {rule.metric} {getConditionText()} {formatNumber(rule.threshold)}
                            </Text>
                        </div>
                    </Group>

                    <Group spacing="xs" noWrap>
                        <Badge 
                            color={getSeverityColor()}
                            variant="outline"
                            size="sm"
                        >
                            {rule.severity}
                        </Badge>
                        <Switch
                            checked={rule.enabled}
                            onChange={handleToggleEnabled}
                            loading={isToggling}
                            size="sm"
                        />
                        <Menu position="bottom-end">
                            <Menu.Target>
                                <ActionIcon>
                                    <IconDots size={16} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                <Menu.Item
                                    icon={<IconEdit size={16} />}
                                    onClick={() => setShowEdit(true)}
                                >
                                    Edit Rule
                                </Menu.Item>
                                <Menu.Item
                                    icon={<IconTrash size={16} />}
                                    color="red"
                                    onClick={handleDelete}
                                    loading={isDeleting}
                                >
                                    Delete Rule
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    </Group>
                </Group>
            </Paper>

            <Modal
                opened={showEdit}
                onClose={() => setShowEdit(false)}
                title="Edit Alert Rule"
            >
                <AlertRuleForm
                    initialValues={rule}
                    onSubmit={handleUpdate}
                />
            </Modal>
        </>
    );
};
