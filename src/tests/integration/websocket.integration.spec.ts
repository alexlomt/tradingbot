import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { WebSocketService } from '../../services/websocket/WebSocketService';
import { MetricsService } from '../../services/metrics/MetricsService';
import { AuditService } from '../../services/audit/AuditService';
import { firstValueFrom, timeout, take } from 'rxjs';
import { Decimal } from 'decimal.js';

describe('WebSocket Integration Tests', () => {
    let app: TestingModule;
    let webSocketService: WebSocketService;

    beforeAll(async () => {
        app = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    envFilePath: '.env.test',
                }),
            ],
            providers: [
                WebSocketService,
                MetricsService,
                AuditService,
            ],
        }).compile();

        webSocketService = app.get<WebSocketService>(WebSocketService);
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('Market Data Integration', () => {
        const TEST_MARKET = 'SOL-USD';
        
        it('should receive orderbook updates', async () => {
            await webSocketService.subscribe(TEST_MARKET, ['orderbook']);
            
            const update = await firstValueFrom(
                webSocketService.getOrderBookUpdates(TEST_MARKET).pipe(
                    take(1),
                    timeout(5000)
                )
            );

            expect(update).toBeDefined();
            expect(update.bids.length).toBeGreaterThan(0);
            expect(update.asks.length).toBeGreaterThan(0);
            expect(update.bids[0][0]).toBeInstanceOf(Decimal);
        }, 10000);

        it('should receive trade updates', async () => {
            await webSocketService.subscribe(TEST_MARKET, ['trades']);
            
            const trade = await firstValueFrom(
                webSocketService.getTradeUpdates(TEST_MARKET).pipe(
                    take(1),
                    timeout(5000)
                )
            );

            expect(trade).toBeDefined();
            expect(trade.price).toBeInstanceOf(Decimal);
            expect(trade.size).toBeInstanceOf(Decimal);
            expect(['buy', 'sell']).toContain(trade.side);
        }, 10000);

        it('should maintain connection during high message volume', async () => {
            const messages: any[] = [];
            const subscription = webSocketService
                .getMarketData(TEST_MARKET)
                .pipe(take(100))
                .subscribe({
                    next: (data) => messages.push(data),
                    error: fail,
                });

            await new Promise(resolve => setTimeout(resolve, 5000));
            await subscription.unsubscribe();

            expect(messages.length).toBeGreaterThan(0);
            expect(messages.every(m => m.lastPrice instanceof Decimal)).toBe(true);
        }, 15000);
    });

    describe('Error Recovery', () => {
        it('should reconnect after connection loss', async () => {
            const connectionStatus = await firstValueFrom(
                webSocketService.getConnectionStatus().pipe(take(2))
            );
            expect(connectionStatus).toBe(true);
        }, 10000);

        it('should resubscribe to channels after reconnection', async () => {
            const TEST_MARKET = 'SOL-USD';
            await webSocketService.subscribe(TEST_MARKET, ['orderbook']);
            
            // Force reconnection
            await app.get(WebSocketService)['handleDisconnect']();
            
            const update = await firstValueFrom(
                webSocketService.getOrderBookUpdates(TEST_MARKET).pipe(
                    take(1),
                    timeout(5000)
                )
            );

            expect(update).toBeDefined();
            expect(update.bids.length).toBeGreaterThan(0);
        }, 15000);
    });

    describe('Performance', () => {
        it('should handle rapid subscription changes', async () => {
            const TEST_MARKETS = ['SOL-USD', 'BTC-USD', 'ETH-USD'];
            const ITERATIONS = 10;

            for (let i = 0; i < ITERATIONS; i++) {
                await Promise.all(
                    TEST_MARKETS.map(market => 
                        webSocketService.subscribe(market, ['trades'])
                    )
                );

                await Promise.all(
                    TEST_MARKETS.map(market => 
                        webSocketService.unsubscribe(market, ['trades'])
                    )
                );
            }

            // Verify we're still connected and functional
            const status = await firstValueFrom(
                webSocketService.getConnectionStatus().pipe(take(1))
            );
            expect(status).toBe(true);
        }, 20000);
    });
});
