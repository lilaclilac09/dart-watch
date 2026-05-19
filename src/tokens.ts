export interface Token {
  mint:     string;
  decimals: number;
  symbol:   string;
}

export const TOKENS: Record<string, Token> = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112',  decimals: 9, symbol: 'SOL'  },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT' },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6, symbol: 'JUP'  },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, symbol: 'BONK' },
  mSOL: { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  decimals: 9, symbol: 'mSOL' },
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6, symbol: 'WIF'  },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  decimals: 6, symbol: 'ORCA' },
  RAY:  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  decimals: 6, symbol: 'RAY'  },
};

export function fmtHuman(raw: bigint, decimals: number, dp = 4): string {
  const s     = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac  = s.slice(-decimals).slice(0, dp);
  return Number(`${whole}.${frac}`).toLocaleString('en-US', { maximumFractionDigits: dp });
}

export function toRaw(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

export function toHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
