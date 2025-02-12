import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Activity, Plus, StopCircle } from 'lucide-react';

const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

const Dashboard = () => {
  const [activeBots, setActiveBots] = useState([]);
  const [error, setError] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [loading, setLoading] = useState(true);

  // WebSocket connection handler
  const connectWebSocket = useCallback(() => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsConnected(true);
      setReconnectAttempts(0);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        setActiveBots(currentBots => 
          currentBots.map(bot => 
            bot.id === update.botId ? { ...bot, ...update } : bot
          )
        );
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    };

    ws.onerror = () => {
      setWsConnected(false);
    };

    ws.onclose = () => {
      setWsConnected(false);
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          connectWebSocket();
        }, RECONNECT_DELAY);
      }
    };

    return ws;
  }, [reconnectAttempts]);

  // Fetch bots from API
  const fetchBots = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/bots');
      if (!response.ok) throw new Error('Unable to fetch bots');
      const data = await response.json();
      setActiveBots(data);
      setError(null);
    } catch (err) {
      setError('Unable to load bots. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBots();
    const ws = connectWebSocket();

    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [connectWebSocket]);

  const handleStopBot = async (botId) => {
    try {
      const response = await fetch(`/api/bots/${botId}/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new Error('Failed to stop bot');
      }
      
      const updatedBot = await response.json();
      setActiveBots(currentBots =>
        currentBots.map(bot =>
          bot.id === botId ? updatedBot : bot
        )
      );
    } catch (err) {
      setError('Failed to stop bot. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex justify-center items-center min-h-screen">
        <Activity className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Trading Dashboard</h1>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-2 py-1 rounded ${
            wsConnected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}>
            <Activity className="w-4 h-4 mr-1" />
            {wsConnected ? 'Live Updates' : 'Connecting...'}
          </span>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {activeBots.map((bot) => (
          <Card key={bot.id}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <h3 className="font-semibold">{bot.name}</h3>
              <span className={`px-2 py-1 rounded text-sm ${
                bot.status === 'running' ? 'bg-green-100 text-green-800' : 
                'bg-red-100 text-red-800'
              }`}>
                {bot.status}
              </span>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <p className="text-sm">Wallet: {bot.walletPublicKey}</p>
                <p className="text-sm">Quote Token: {bot.quoteToken}</p>
                <p className="text-sm">Total Trades: {bot.totalTrades}</p>
                <p className="text-sm">Profit/Loss: {bot.profitLoss}</p>
              </div>

              <Button 
                variant="destructive"
                className="w-full mt-4"
                onClick={() => handleStopBot(bot.id)}
                disabled={bot.status !== 'running'}
              >
                <StopCircle className="w-4 h-4 mr-2" />
                Stop Bot
              </Button>
            </CardContent>
          </Card>
        ))}

        <Card className="border-2 border-dashed border-gray-300">
          <CardContent>
            <Button 
              variant="ghost"
              className="w-full h-full min-h-[200px] flex flex-col items-center justify-center"
              onClick={() => window.location.href = '/bots/new'}
            >
              <Plus className="w-8 h-8 mb-2" />
              <span>Create New Bot</span>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Dashboard;