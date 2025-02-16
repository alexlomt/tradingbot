import React, { useEffect, useRef, useMemo } from 'react';
import { Paper } from '@mantine/core';
import { scaleLinear, scaleLog } from 'd3-scale';
import { area, curveStepAfter } from 'd3-shape';
import { axisBottom, axisRight } from 'd3-axis';
import { select } from 'd3-selection';
import { format } from 'd3-format';
import { Decimal } from 'decimal.js';
import { useResizeObserver } from '@mantine/hooks';
import { useMarketData } from '../hooks/useMarketData';
import { OrderBookLevel } from '../types/market.types';
import { formatPrice, formatNumber } from '../utils/formatters';

interface MarketDepthChartProps {
    market: string;
    height?: number;
    logScale?: boolean;
}

export const MarketDepthChart: React.FC<MarketDepthChartProps> = ({
    market,
    height = 400,
    logScale = false
}) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const [ref, rect] = useResizeObserver();
    const { getOrderBook, subscribeToOrderBook } = useMarketData();

    const [bids, setBids] = useState<OrderBookLevel[]>([]);
    const [asks, setAsks] = useState<OrderBookLevel[]>([]);

    useEffect(() => {
        const loadOrderBook = async () => {
            const orderBook = await getOrderBook(market);
            setBids(orderBook.bids);
            setAsks(orderBook.asks);
        };
        loadOrderBook();

        const unsubscribe = subscribeToOrderBook(market, (orderBook) => {
            setBids(orderBook.bids);
            setAsks(orderBook.asks);
        });

        return () => unsubscribe();
    }, [market]);

    const chartData = useMemo(() => {
        const processLevels = (
            levels: OrderBookLevel[],
            side: 'bid' | 'ask'
        ): [number, number][] => {
            let cumulative = new Decimal(0);
            return levels.map(level => {
                cumulative = cumulative.plus(level.size);
                return [
                    level.price.toNumber(),
                    cumulative.toNumber()
                ];
            });
        };

        const bidPoints = processLevels(bids, 'bid').reverse();
        const askPoints = processLevels(asks, 'ask');

        const midPrice = bids[0] && asks[0] ?
            bids[0].price.plus(asks[0].price).div(2).toNumber() :
            0;

        return {
            bidPoints,
            askPoints,
            midPrice,
            maxDepth: Math.max(
                bidPoints.length ? bidPoints[bidPoints.length - 1][1] : 0,
                askPoints.length ? askPoints[askPoints.length - 1][1] : 0
            )
        };
    }, [bids, asks]);

    useEffect(() => {
        if (!svgRef.current || !rect.width || !chartData.midPrice) return;

        const margin = { top: 20, right: 60, bottom: 30, left: 60 };
        const width = rect.width - margin.left - margin.right;
        const chartHeight = height - margin.top - margin.bottom;

        const svg = select(svgRef.current);
        svg.selectAll('*').remove();

        const g = svg
            .attr('width', width + margin.left + margin.right)
            .attr('height', height)
            .append('g')
            .attr('transform', `translate(${margin.left},${margin.top})`);

        // Calculate price range
        const priceRange = 0.1; // 10% from mid price
        const minPrice = chartData.midPrice * (1 - priceRange);
        const maxPrice = chartData.midPrice * (1 + priceRange);

        // Scales
        const xScale = scaleLinear()
            .domain([minPrice, maxPrice])
            .range([0, width]);

        const yScale = logScale ?
            scaleLog()
                .domain([0.1, chartData.maxDepth * 1.1])
                .range([chartHeight, 0]) :
            scaleLinear()
                .domain([0, chartData.maxDepth * 1.1])
                .range([chartHeight, 0]);

        // Create areas
        const bidArea = area<[number, number]>()
            .x(d => xScale(d[0]))
            .y0(chartHeight)
            .y1(d => yScale(d[1]))
            .curve(curveStepAfter);

        const askArea = area<[number, number]>()
            .x(d => xScale(d[0]))
            .y0(chartHeight)
            .y1(d => yScale(d[1]))
            .curve(curveStepAfter);

        // Draw areas
        g.append('path')
            .datum(chartData.bidPoints)
            .attr('class', 'depth-bid')
            .attr('fill', 'rgba(39, 174, 96, 0.2)')
            .attr('stroke', 'rgb(39, 174, 96)')
            .attr('stroke-width', 1)
            .attr('d', bidArea);

        g.append('path')
            .datum(chartData.askPoints)
            .attr('class', 'depth-ask')
            .attr('fill', 'rgba(231, 76, 60, 0.2)')
            .attr('stroke', 'rgb(231, 76, 60)')
            .attr('stroke-width', 1)
            .attr('d', askArea);

        // Add axes
        const xAxis = axisBottom(xScale)
            .tickFormat(d => formatPrice(new Decimal(d as number)));
        
        const yAxis = axisRight(yScale)
            .tickFormat(d => formatNumber(new Decimal(d as number)));

        g.append('g')
            .attr('transform', `translate(0,${chartHeight})`)
            .attr('class', 'x-axis')
            .call(xAxis);

        g.append('g')
            .attr('transform', `translate(${width},0)`)
            .attr('class', 'y-axis')
            .call(yAxis);

        // Add mid price line
        g.append('line')
            .attr('x1', xScale(chartData.midPrice))
            .attr('x2', xScale(chartData.midPrice))
            .attr('y1', 0)
            .attr('y2', chartHeight)
            .attr('stroke', 'rgba(255, 255, 255, 0.5)')
            .attr('stroke-dasharray', '4,4');

        // Add hover effects
        const tooltip = select('body')
            .append('div')
            .attr('class', 'depth-tooltip')
            .style('position', 'absolute')
            .style('visibility', 'hidden')
            .style('background-color', 'rgba(0, 0, 0, 0.8)')
            .style('color', 'white')
            .style('padding', '8px')
            .style('border-radius', '4px')
            .style('font-size', '12px');

        const bisectPrice = bisector<[number, number], number>(d => d[0]).left;

        g.append('rect')
            .attr('width', width)
            .attr('height', chartHeight)
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .on('mousemove', (event) => {
                const [mx] = pointer(event);
                const price = xScale.invert(mx);
                
                const bidIndex = bisectPrice(chartData.bidPoints, price);
                const askIndex = bisectPrice(chartData.askPoints, price);
                
                const bidPoint = chartData.bidPoints[bidIndex];
                const askPoint = chartData.askPoints[askIndex];

                let content = '';
                if (price <= chartData.midPrice && bidPoint) {
                    content = `
                        Price: ${formatPrice(new Decimal(bidPoint[0]))}<br/>
                        Cumulative Bid Size: ${formatNumber(new Decimal(bidPoint[1]))}
                    `;
                } else if (askPoint) {
                    content = `
                        Price: ${formatPrice(new Decimal(askPoint[0]))}<br/>
                        Cumulative Ask Size: ${formatNumber(new Decimal(askPoint[1]))}
                    `;
                }

                tooltip
                    .style('visibility', 'visible')
                    .style('left', `${event.pageX + 10}px`)
                    .style('top', `${event.pageY - 10}px`)
                    .html(content);
            })
            .on('mouseout', () => {
                tooltip.style('visibility', 'hidden');
            });

    }, [rect.width, height, chartData, logScale]);

    return (
        <Paper ref={ref} p="md">
            <svg ref={svgRef} />
        </Paper>
    );
};
