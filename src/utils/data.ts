// src/utils/data.ts
export class DataUtils {
    static formatTokenAmount(amount: number, decimals: number): string {
        return amount.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    static shortenAddress(address: string): string {
        if (address.length <= 8) return address;
        return `${address.slice(0, 4)}...${address.slice(-4)}`;
    }

    static parseTokenAmount(amount: string, decimals: number): BN {
        const parts = amount.split('.');
        let whole = parts[0] || '0';
        let fraction = parts[1] || '';

        if (fraction.length > decimals) {
            throw new Error('Too many decimal places');
        }

        while (fraction.length < decimals) {
            fraction += '0';
        }

        return new BN(whole + fraction);
    }

    static timestampToDate(timestamp: number): Date {
        return new Date(timestamp * 1000);
    }
}