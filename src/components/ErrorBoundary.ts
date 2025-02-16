import React, { Component, ErrorInfo } from 'react';
import {
    Paper,
    Title,
    Text,
    Button,
    Stack,
    Group,
    Code,
    Alert
} from '@mantine/core';
import { IconAlertCircle, IconRefresh } from '@tabler/icons-react';
import { PerformanceMonitor } from '../utils/performance';
import { logger } from '../utils/logger';

interface Props {
    children: React.ReactNode;
    fallback?: React.ReactNode;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    resetCondition?: any;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null
        };
    }

    static getDerivedStateFromError(error: Error): State {
        return {
            hasError: true,
            error,
            errorInfo: null
        };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        this.setState({ errorInfo });

        // Log error
        logger.error('React Error Boundary caught an error:', {
            error: error.message,
            stack: error.stack,
            componentStack: errorInfo.componentStack
        });

        // Record performance impact
        PerformanceMonitor.recordMetric('error-boundary', {
            timestamp: new Date(),
            duration: 0,
            context: {
                errorMessage: error.message,
                errorType: error.name
            }
        });

        // Call custom error handler if provided
        if (this.props.onError) {
            this.props.onError(error, errorInfo);
        }
    }

    componentDidUpdate(prevProps: Props): void {
        if (this.props.resetCondition !== prevProps.resetCondition) {
            this.reset();
        }
    }

    reset = (): void => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null
        });
    };

    render(): React.ReactNode {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <Paper p="xl" shadow="md">
                    <Stack spacing="md">
                        <Alert
                            icon={<IconAlertCircle size={16} />}
                            title="Something went wrong"
                            color="red"
                        >
                            We apologize for the inconvenience. Please try refreshing 
                            the page or contact support if the problem persists.
                        </Alert>

                        <Title order={3}>Error Details</Title>
                        <Text color="dimmed">
                            {this.state.error?.message}
                        </Text>

                        {process.env.NODE_ENV === 'development' && (
                            <>
                                <Title order={4}>Stack Trace</Title>
                                <Code block>
                                    {this.state.error?.stack}
                                </Code>

                                <Title order={4}>Component Stack</Title>
                                <Code block>
                                    {this.state.errorInfo?.componentStack}
                                </Code>
                            </>
                        )}

                        <Group position="apart">
                            <Button
                                leftIcon={<IconRefresh size={16} />}
                                onClick={this.reset}
                            >
                                Try Again
                            </Button>

                            <Button
                                variant="subtle"
                                onClick={() => window.location.reload()}
                            >
                                Refresh Page
                            </Button>
                        </Group>
                    </Stack>
                </Paper>
            );
        }

        return this.props.children;
    }
}
