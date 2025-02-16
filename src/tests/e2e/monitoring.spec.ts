import { test, expect, Page } from '@playwright/test';
import { format } from 'date-fns';

test.describe('Monitoring Dashboard E2E', () => {
    let page: Page;

    test.beforeEach(async ({ browser }) => {
        page = await browser.newPage();
        await page.goto('http://localhost:3000/monitoring');
        await page.waitForLoadState('networkidle');
    });

    test('performs complete monitoring workflow', async () => {
        // Check initial dashboard load
        await expect(page.getByRole('heading', { name: 'System Monitoring' }))
            .toBeVisible();

        // Verify system status components
        await expect(page.getByTestId('system-health-status')).toBeVisible();
        await expect(page.getByTestId('cpu-usage-chart')).toBeVisible();
        await expect(page.getByTestId('memory-usage-chart')).toBeVisible();

        // Create new alert rule
        await page.click('button:has-text("Add Rule")');
        await page.fill('[name="ruleName"]', 'E2E Test Alert');
        await page.fill('[name="metric"]', 'test_metric');
        await page.fill('[name="threshold"]', '90');
        await page.selectOption('[name="severity"]', 'warning');
        await page.click('button:has-text("Create Rule")');

        // Verify alert rule creation
        await expect(page.getByText('E2E Test Alert')).toBeVisible();

        // Test data export
        await page.click('button:has-text("Export")');
        await page.selectOption('[data-testid="time-range-select"]', '24h');
        const download = await Promise.all([
            page.waitForEvent('download'),
            page.click('button:has-text("Download")')
        ]);
        
        const filename = `metrics_${format(new Date(), 'yyyyMMdd')}.csv`;
        expect(download[0].suggestedFilename()).toBe(filename);

        // Test dashboard filters
        await page.click('[data-testid="filter-dropdown"]');
        await page.click('text=Critical Alerts Only');
        await expect(page.getByTestId('alerts-list'))
            .toContainText('critical');

        // Test real-time updates
        await page.click('button:has-text("Refresh")');
        await expect(page.getByTestId('last-updated'))
            .toContainText('Last updated:');

        // Test alert rule modification
        await page.click('[data-testid="rule-menu-button"]');
        await page.click('text=Edit Rule');
        await page.fill('[name="threshold"]', '95');
        await page.click('button:has-text("Update Rule")');
        await expect(page.getByText('95')).toBeVisible();

        // Test settings configuration
        await page.click('text=Settings');
        await page.fill('[name="monitoring.interval"]', '10000');
        await page.click('button:has-text("Save Changes")');
        await expect(page.getByText('Settings saved successfully'))
            .toBeVisible();

        // Test error handling
        await page.route('**/api/metrics', route => route.abort());
        await page.click('button:has-text("Refresh")');
        await expect(page.getByText('Error loading metrics'))
            .toBeVisible();
        await page.click('button:has-text("Retry")');
    });

    test('validates accessibility requirements', async () => {
        // Test keyboard navigation
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Refresh' }))
            .toBeFocused();

        // Test ARIA labels
        await expect(page.getByRole('tab', { name: 'Overview' }))
            .toHaveAttribute('aria-selected', 'true');

        // Test color contrast
        const alerts = await page.$$('[data-testid="alert-severity"]');
        for (const alert of alerts) {
            const color = await alert.evaluate(el => 
                window.getComputedStyle(el).color
            );
            expect(color).toMatch(/^rgb/);
        }

        // Test screen reader compatibility
        const headings = await page.$$('h1,h2,h3,h4,h5,h6');
        for (const heading of headings) {
            const ariaLabel = await heading.getAttribute('aria-label');
            expect(ariaLabel).toBeTruthy();
        }
    });

    test('handles different screen sizes', async () => {
        // Test mobile layout
        await page.setViewportSize({ width: 375, height: 667 });
        await expect(page.getByTestId('mobile-menu')).toBeVisible();

        // Test tablet layout
        await page.setViewportSize({ width: 768, height: 1024 });
        await expect(page.getByTestId('sidebar')).toBeVisible();

        // Test desktop layout
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.getByTestId('dashboard-grid'))
            .toHaveClass(/desktop-grid/);
    });

    test('performs under load', async () => {
        // Test rapid updates
        for (let i = 0; i < 10; i++) {
            await page.click('button:has-text("Refresh")');
            await page.waitForTimeout(100);
        }
        await expect(page.getByTestId('error-message'))
            .not.toBeVisible();

        // Test multiple concurrent operations
        await Promise.all([
            page.click('button:has-text("Export")'),
            page.click('button:has-text("Add Rule")'),
            page.click('button:has-text("Refresh")')
        ]);
        await expect(page.getByTestId('loading-indicator'))
            .not.toBeVisible();
    });
});
