import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertRuleForm } from '../components/AlertRuleForm';
import { AlertRule } from '../types/monitoring.types';
import { Decimal } from 'decimal.js';
import '@testing-library/jest-dom';

describe('AlertRuleForm', () => {
    const mockOnSubmit = jest.fn();
    
    const defaultRule: Partial<AlertRule> = {
        name: 'Test Rule',
        metric: 'cpu_usage',
        condition: 'gt',
        threshold: new Decimal('80'),
        severity: 'warning',
        duration: 300,
        enabled: true,
        notificationChannels: ['email']
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renders with initial values', () => {
        render(
            <AlertRuleForm 
                initialValues={defaultRule}
                onSubmit={mockOnSubmit}
            />
        );

        expect(screen.getByDisplayValue('Test Rule')).toBeInTheDocument();
        expect(screen.getByDisplayValue('cpu_usage')).toBeInTheDocument();
        expect(screen.getByDisplayValue('80')).toBeInTheDocument();
        expect(screen.getByDisplayValue('300')).toBeInTheDocument();
    });

    it('validates required fields', async () => {
        render(<AlertRuleForm onSubmit={mockOnSubmit} />);

        fireEvent.click(screen.getByRole('button', { name: /create rule/i }));

        await waitFor(() => {
            expect(screen.getByText('Name is required')).toBeInTheDocument();
            expect(screen.getByText('Metric is required')).toBeInTheDocument();
        });

        expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('validates threshold format', async () => {
        render(<AlertRuleForm onSubmit={mockOnSubmit} />);

        const thresholdInput = screen.getByLabelText(/threshold/i);
        await userEvent.type(thresholdInput, 'invalid');

        fireEvent.click(screen.getByRole('button', { name: /create rule/i }));

        await waitFor(() => {
            expect(screen.getByText('Invalid threshold format')).toBeInTheDocument();
        });

        expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('submits form with valid data', async () => {
        render(<AlertRuleForm onSubmit={mockOnSubmit} />);

        await userEvent.type(screen.getByLabelText(/rule name/i), 'New Rule');
        await userEvent.type(screen.getByLabelText(/metric/i), 'memory_usage');
        await userEvent.type(screen.getByLabelText(/threshold/i), '90');
        
        const severitySelect = screen.getByLabelText(/severity/i);
        await userEvent.selectOptions(severitySelect, 'critical');

        const channelSelect = screen.getByLabelText(/notification channels/i);
        await userEvent.click(channelSelect);
        await userEvent.click(screen.getByText(/slack/i));

        fireEvent.click(screen.getByRole('button', { name: /create rule/i }));

        await waitFor(() => {
            expect(mockOnSubmit).toHaveBeenCalledWith(expect.objectContaining({
                name: 'New Rule',
                metric: 'memory_usage',
                threshold: expect.any(Decimal),
                severity: 'critical',
                notificationChannels: ['slack']
            }));
        });
    });

    it('handles form submission errors', async () => {
        const mockError = new Error('Submission failed');
        const mockOnSubmitError = jest.fn().mockRejectedValue(mockError);

        render(
            <AlertRuleForm 
                initialValues={defaultRule}
                onSubmit={mockOnSubmitError}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /update rule/i }));

        await waitFor(() => {
            expect(screen.getByText('Failed to save alert rule')).toBeInTheDocument();
        });
    });

    it('resets form after successful submission', async () => {
        render(<AlertRuleForm onSubmit={mockOnSubmit} />);

        await userEvent.type(screen.getByLabelText(/rule name/i), 'Test Rule');
        await userEvent.type(screen.getByLabelText(/metric/i), 'cpu_usage');
        await userEvent.type(screen.getByLabelText(/threshold/i), '80');

        fireEvent.click(screen.getByRole('button', { name: /create rule/i }));

        await waitFor(() => {
            expect(screen.getByLabelText(/rule name/i)).toHaveValue('');
            expect(screen.getByLabelText(/metric/i)).toHaveValue('');
        });
    });
});
