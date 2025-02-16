import { createStyles } from '@mantine/core';

export const useStyles = createStyles((theme) => ({
    root: {
        height: '100vh',
        display: 'flex',
        flexDirection: 'column'
    },

    header: {
        borderBottom: `1px solid ${theme.colors.gray[3]}`,
        backgroundColor: theme.white,
        zIndex: 100
    },

    navbar: {
        backgroundColor: theme.white,
        borderRight: `1px solid ${theme.colors.gray[3]}`,
        width: 250,

        [`@media (max-width: ${theme.breakpoints.sm}px)`]: {
            display: 'none'
        }
    },

    content: {
        flex: 1,
        padding: theme.spacing.md,
        backgroundColor: theme.colors.gray[0],
        overflowY: 'auto'
    },

    card: {
        backgroundColor: theme.white,
        borderRadius: theme.radius.md,
        boxShadow: theme.shadows.xs
    },

    statCard: {
        display: 'flex',
        flexDirection: 'column',
        padding: theme.spacing.md,
        minHeight: 120
    },

    statValue: {
        fontSize: 28,
        fontWeight: 700,
        lineHeight: 1,
        marginTop: 'auto',
        color: theme.colors.blue[6]
    },

    statLabel: {
        fontSize: theme.fontSizes.sm,
        fontWeight: 500,
        color: theme.colors.gray[6],
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },

    alertBadge: {
        textTransform: 'capitalize',
        fontWeight: 500
    },

    criticalAlert: {
        backgroundColor: theme.fn.rgba(theme.colors.red[6], 0.1),
        color: theme.colors.red[6],
        border: `1px solid ${theme.colors.red[3]}`
    },

    warningAlert: {
        backgroundColor: theme.fn.rgba(theme.colors.yellow[6], 0.1),
        color: theme.colors.yellow[6],
        border: `1px solid ${theme.colors.yellow[3]}`
    },

    infoAlert: {
        backgroundColor: theme.fn.rgba(theme.colors.blue[6], 0.1),
        color: theme.colors.blue[6],
        border: `1px solid ${theme.colors.blue[3]}`
    },

    chartContainer: {
        height: 400,
        marginTop: theme.spacing.md
    },

    tabsContainer: {
        marginTop: theme.spacing.md,

        '.mantine-Tabs-tabLabel': {
            fontWeight: 500
        }
    },

    refreshButton: {
        transition: 'transform 0.2s ease',

        '&:active': {
            transform: 'rotate(180deg)'
        }
    },

    exportButton: {
        backgroundColor: theme.colors.green[6],
        color: theme.white,

        '&:hover': {
            backgroundColor: theme.colors.green[7]
        }
    }
}));
