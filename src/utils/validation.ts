// src/utils/validation.ts
export class ValidationUtils {
    static isValidSolanaAddress(address: string): boolean {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    static isValidAmount(amount: string): boolean {
        const regex = /^\d*\.?\d+$/;
        return regex.test(amount);
    }

    static isValidSlippage(slippage: number): boolean {
        return slippage >= 0 && slippage <= 100;
    }

    static isValidURL(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}
