import React, { useEffect, useState } from 'react';
import {
    AppShell,
    Navbar,
    Header,
    Box,
    UnstyledButton,
    Group,
    ThemeIcon,
    Text,
    Loader,
    useMantineTheme,
    useMantineColorScheme,
    Menu,
    Avatar,
    Tooltip,
    Button,
    ActionIcon,
} from '@mantine/core';
import {
    IconDashboard,
    IconChartLine,
    IconWallet,
    IconSettings,
    IconUser,
    IconBell,
    IconMoonStars,
    IconSun,
    IconLogout,
    IconChevronRight,
} from '@tabler/icons-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useNotifications } from '../../hooks/useNotifications';
import { useWebSocket } from '../../hooks/useWebSocket';
import { TradingStatus } from '../../types/trading.types';
import { formatCurrency } from '../../utils/formatters';

interface NavItemProps {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    onClick?(): void;
}

const NavItem = ({ icon, label, active, onClick }: NavItemProps) => {
    const theme = useMantineTheme();

    return (
        <UnstyledButton
            onClick={onClick}
            sx={(theme) => ({
                display: 'block',
                width: '100%',
                padding: theme.spacing.xs,
                borderRadius: theme.radius.sm,
                color: active ? theme.colors.blue[6] : theme.colors.gray[6],
                backgroundColor: active ? theme.colors.blue[0] : 'transparent',
                '&:hover': {
                    backgroundColor: theme.colors.gray[0],
                },
            })}
        >
            <Group>
                <ThemeIcon variant={active ? 'filled' : 'light'} size={30}>
                    {icon}
                </ThemeIcon>
                <Text size="sm" weight={500}>
                    {label}
                </Text>
            </Group>
        </UnstyledButton>
    );
};

export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const theme = useMantineTheme();
    const { colorScheme, toggleColorScheme } = useMantineColorScheme();
    const navigate = useNavigate();
    const location = useLocation();
    const { user, logout } = useAuth();
    const { notifications, markAsRead } = useNotifications();
    const { lastMessage, tradingStatus } = useWebSocket();
    const [portfolioValue, setPortfolioValue] = useState<number>(0);
    const [dailyPnL, setDailyPnL] = useState<number>(0);

    useEffect(() => {
        if (lastMessage?.type === 'PORTFOLIO_UPDATE') {
            setPortfolioValue(lastMessage.data.totalValue);
            setDailyPnL(lastMessage.data.dailyPnL);
        }
    }, [lastMessage]);

    const navItems = [
        { icon: <IconDashboard size={18} />, label: 'Dashboard', path: '/dashboard' },
        { icon: <IconChartLine size={18} />, label: 'Trading', path: '/trading' },
        { icon: <IconWallet size={18} />, label: 'Portfolio', path: '/portfolio' },
        { icon: <IconSettings size={18} />, label: 'Settings', path: '/settings' },
    ];

    const handleNavigation = (path: string) => {
        navigate(path);
    };

    return (
        <AppShell
            padding="md"
            navbar={
                <Navbar width={{ base: 250 }} p="xs">
                    <Navbar.Section grow>
                        {navItems.map((item) => (
                            <NavItem
                                key={item.path}
                                icon={item.icon}
                                label={item.label}
                                active={location.pathname === item.path}
                                onClick={() => handleNavigation(item.path)}
                            />
                        ))}
                    </Navbar.Section>

                    <Navbar.Section>
                        <Box
                            sx={{
                                padding: theme.spacing.sm,
                                borderTop: `1px solid ${theme.colors.gray[2]}`,
                            }}
                        >
                            <Group position="apart" align="center">
                                <Text size="xs" color="dimmed">
                                    Trading Status
                                </Text>
                                <Group spacing={8}>
                                    {tradingStatus === TradingStatus.ACTIVE ? (
                                        <Text size="xs" color="green">
                                            Active
                                        </Text>
                                    ) : tradingStatus === TradingStatus.PAUSED ? (
                                        <Text size="xs" color="orange">
                                            Paused
                                        </Text>
                                    ) : (
                                        <Text size="xs" color="red">
                                            Stopped
                                        </Text>
                                    )}
                                    <div
                                        style={{
                                            width: 8,
                                            height: 8,
                                            borderRadius: '50%',
                                            backgroundColor:
                                                tradingStatus === TradingStatus.ACTIVE
                                                    ? theme.colors.green[6]
                                                    : tradingStatus === TradingStatus.PAUSED
                                                    ? theme.colors.orange[6]
                                                    : theme.colors.red[6],
                                        }}
                                    />
                                </Group>
                            </Group>
                        </Box>
                    </Navbar.Section>
                </Navbar>
            }
            header={
                <Header height={60} p="xs">
                    <Group position="apart" sx={{ height: '100%' }}>
                        <Group>
                            <Text size="lg" weight={700}>
                                Solana Trading Bot
                            </Text>
                            <Box mx="md">
                                <Group spacing={4}>
                                    <Text size="sm" weight={500}>
                                        Portfolio:
                                    </Text>
                                    <Text size="sm" color={dailyPnL >= 0 ? 'green' : 'red'}>
                                        {formatCurrency(portfolioValue)}
                                        {' ('}
                                        {dailyPnL > 0 ? '+' : ''}
                                        {formatCurrency(dailyPnL, true)}
                                        {')'}
                                    </Text>
                                </Group>
                            </Box>
                        </Group>

                        <Group>
                            <Menu withArrow position="bottom-end">
                                <Menu.Target>
                                    <ActionIcon
                                        variant="light"
                                        color={
                                            notifications.filter((n) => !n.read).length > 0
                                                ? 'blue'
                                                : 'gray'
                                        }
                                    >
                                        <IconBell size={20} />
                                    </ActionIcon>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    {notifications.length > 0 ? (
                                        notifications.map((notification) => (
                                            <Menu.Item
                                                key={notification.id}
                                                onClick={() => markAsRead(notification.id)}
                                            >
                                                <Text size="sm">{notification.message}</Text>
                                                <Text size="xs" color="dimmed">
                                                    {new Date(
                                                        notification.timestamp
                                                    ).toLocaleString()}
                                                </Text>
                                            </Menu.Item>
                                        ))
                                    ) : (
                                        <Menu.Item disabled>No notifications</Menu.Item>
                                    )}
                                </Menu.Dropdown>
                            </Menu>

                            <ActionIcon
                                variant="light"
                                onClick={() => toggleColorScheme()}
                                title="Toggle color scheme"
                            >
                                {colorScheme === 'dark' ? (
                                    <IconSun size={20} />
                                ) : (
                                    <IconMoonStars size={20} />
                                )}
                            </ActionIcon>

                            <Menu withArrow position="bottom-end">
                                <Menu.Target>
                                    <UnstyledButton>
                                        <Group spacing={8}>
                                            <Avatar
                                                src={user?.avatar}
                                                radius="xl"
                                                size={30}
                                            />
                                            <Text size="sm" weight={500}>
                                                {user?.username}
                                            </Text>
                                            <IconChevronRight size={16} />
                                        </Group>
                                    </UnstyledButton>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Menu.Item
                                        icon={<IconUser size={16} />}
                                        onClick={() => navigate('/profile')}
                                    >
                                        Profile
                                    </Menu.Item>
                                    <Menu.Item
                                        icon={<IconSettings size={16} />}
                                        onClick={() => navigate('/settings')}
                                    >
                                        Settings
                                    </Menu.Item>
                                    <Menu.Divider />
                                    <Menu.Item
                                        color="red"
                                        icon={<IconLogout size={16} />}
                                        onClick={logout}
                                    >
                                        Logout
                                    </Menu.Item>
                                </Menu.Dropdown>
                            </Menu>
                        </Group>
                    </Group>
                </Header>
            }
        >
            {children}
        </AppShell>
    );
};

export default DashboardLayout;
