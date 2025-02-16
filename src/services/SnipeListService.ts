import { PublicKey } from '@solana/web3.js';
import { Cache } from '../utils/Cache';
import fs from 'fs';

export class SnipeListService {
    private readonly snipeList: Set<string>;
    private readonly cache: Cache<string, boolean>;
    private readonly filePath: string;

    constructor(
        filePath: string = 'snipe-list.json',
        cacheDuration: number = 300000 // 5 minutes
    ) {
        this.filePath = filePath;
        this.snipeList = new Set();
        this.cache = new Cache<string, boolean>(cacheDuration);
        this.loadSnipeList();
    }

    private loadSnipeList(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                data.tokens.forEach(token => this.snipeList.add(token));
            }
        } catch (error) {
            console.error('Error loading snipe list:', error);
        }
    }

    public isTokenInSnipeList(tokenAddress: PublicKey): boolean {
        const address = tokenAddress.toString();
        const cached = this.cache.get(address);
        if (cached !== undefined) return cached;

        const result = this.snipeList.has(address);
        this.cache.set(address, result);
        return result;
    }

    public addToSnipeList(tokenAddress: string): void {
        this.snipeList.add(tokenAddress);
        this.cache.set(tokenAddress, true);
        this.saveSnipeList();
    }

    public removeFromSnipeList(tokenAddress: string): void {
        this.snipeList.delete(tokenAddress);
        this.cache.delete(tokenAddress);
        this.saveSnipeList();
    }

    private saveSnipeList(): void {
        try {
            fs.writeFileSync(
                this.filePath,
                JSON.stringify({
                    tokens: Array.from(this.snipeList)
                }, null, 2)
            );
        } catch (error) {
            console.error('Error saving snipe list:', error);
        }
    }

    public getSnipeList(): string[] {
        return Array.from(this.snipeList);
    }
}
