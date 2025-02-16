import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebSocketService } from '../services/websocket/WebSocketService';
import { MetricsService } from '../services/metrics/MetricsService';
import { AuditService } from '../services/audit/AuditService';
import { w3cwebsocket as W3CWebSocket } from 'websocket';
import { Decimal } from 'decimal.js';
import { firstValueFrom, take, timeout } from 'rxjs';

jest.mock('websocket', () => ({
    w3cwebsocket: jest.fn()
}));

describe('WebSocketService', () => {
    let service: WebSocketService;
    let mockWs: any;
    let mockConfigService: Partial<ConfigService>;
    let mockMetricsService: Partial<MetricsService>;
    let mockAuditService: Partial<AuditService>;

    beforeEach(async () => {
        mockWs = {
            onopen: null,
            onclose: null,
            onerror: null,
            onmessage: null,
            send: jest.fn(),
            close: jest.fn(),
        };

        (W3CWebSocket as jest.Mock).mockImplementation(() => mockWs);

        mockConfigService = {
            get: jest.fn((key: string) => {
                switch (key) {
                    case 'SOLANA_RPC_WEBSOCKET_URL':
                        return 'wss://api.mainnet-beta.solana.com';
                    case 'WEBSOCKET_URL':
                        return 'wss://api.exchange.com/ws';
                    case 'WEBSOCKET_AUTH_KEY':
                        return 'test-auth-key';
                    default:
                        return undefined;
                }
            }),
        };

        mockMetricsService = {
            incrementSubscription: jest.fn(),
            incrementError: jest.fn(),
        };

        mockAuditService = {
            logSystemEvent: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WebSocketService,
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
                {
                    provide: MetricsService,
                    useValue: mockMetricsService,
                },
                {
                    provide: AuditService,
                    useValue: mockAuditService,
                },
            ],
        }).compile();

        service = module.get<WebSocketService>(WebSocketService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Connection Management', () => {
        it('should establish connection on initialization', async () => {
            expect(W3CWebSocket).toHaveBeenCalledWith(
                'wss://api.exchange.com/ws',
                {
                    headers: {
                        'Auth-Key': 'test-auth-key',
                    },
                }
            );
        });

        it('should emit connection status changes', async () => {
            const statusPromise = firstValueFrom(service.getConnectionStatus().pipe(take(1)));
            mockWs.onopen();
            const status = await statusPromise;
            expect(status).toBe(true);
        });

        it('should handle disconnections', async () => {
            const statusPromise = firstValueFrom(service.getConnectionStatus().pipe(take(2)));
            mockWs.onopen();
            mockWs.onclose();
            const status = await statusPromise;
            expect(status).toBe(false);
        });
    });

    describe('Subscription Management', () => {
        it('should handle market subscriptions', async () => {
            mockWs.onopen();
            await service.subscribe('BTC-USD', ['orderbook', 'trades']);
            
            expect(mockWs.send).toHaveBeenCalledWith(
                JSON.stringify({
                    type: 'subscribe',
                    market: 'BTC-USD',
                    channels: ['orderbook', 'trades'],
                })
            );
        });

        it('should handle market unsubscriptions', async () => {
            mockWs.onopen();
            await service.subscribe('BTC-USD', ['orderbook']);
            await service.unsubscribe('BTC-USD', ['orderbook']);
            
            expect(mockWs.send).toHaveBeenLastCalledWith(
                JSON.stringify({
                    type: 'unsubscribe',
                    market: 'BTC-USD',
                    channels: ['orderbook'],
                })
            );
        });
    });

    describe('Data Processing', () => {
        it('should process orderbook updates correctly', async () => {
            const orderBookPromise = firstValueFrom(
                service.getOrderBookUpdates('BTC-USD').pipe(take(1), timeout(1000))
            );

            mockWs.onmessage({
                data: JSON.stringify({
                    type: 'orderbook',
                    market: 'BTC-USD',
                    data: {
                        bids: [['50000.00', '1.5']],
                        asks: [['50100.00', '2.0']],
                    },
                }),
            });

            const update = await orderBookPromise;
            expect(update.bids[0][0]).toEqual(new Decimal('50000.00'));
            expect(update.asks[0][1]).toEqual(new Decimal('2.0'));
        });

        it('should process trade updates correctly', async () => {
            const tradePromise = firstValueFrom(
                service.getTradeUpdates('BTC-USD').pipe(take(1), timeout(1000))
            );

            mockWs.onmessage({
                data: JSON.stringify({
                    type: 'trade',
                    market: 'BTC-USD',
                    data: {
                        price: '50000.00',
                        size: '1.5',
                        side: 'buy',
                        timestamp: '2025-02-16T02:17:42Z',
                    },
                }),
            });

            const trade = await tradePromise;
            expect(trade.price).toEqual(new Decimal('50000.00'));
            expect(trade.size).toEqual(new Decimal('1.5'));
            expect(trade.side).toBe('buy');
        });
    });

    describe('Error Handling', () => {
        it('should handle WebSocket errors', async () => {
            const error = new Error('Connection failed');
            mockWs.onerror(error);

            expect(mockAuditService.logSystemEvent).toHaveBeenCalledWith({
                event: 'WEBSOCKET_ERROR',
                details: {
                    operation: 'websocket_error',
                    error: 'Connection failed',
                },
                severity: 'ERROR',
            });
        });

        it('should handle message parsing errors', async () => {
            mockWs.onmessage({ data: 'invalid json' });

            expect(mockAuditService.logSystemEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: 'WEBSOCKET_ERROR',
                    details: expect.objectContaining({
                        operation: 'message_parse',
                    }),
                })
            );
        });
    });
});
