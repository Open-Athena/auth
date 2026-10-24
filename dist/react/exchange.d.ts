import type { ExchangeOptions } from '../client/exchange.js';
export { exchangeKeyParam, hasKeyParam } from '../client/exchange.js';
export type { ExchangeOptions } from '../client/exchange.js';
/**
 * Run the exchange once on mount if a token is present. Returns whether the
 * identity probe may proceed — false only for the moment the exchange is in
 * flight, so the wall never flashes before a valid link has been redeemed.
 * An optional completion callback is awaited before the probe may proceed.
 */
export declare function useKeyExchange(opts?: ExchangeOptions | false, onComplete?: (exchanged: boolean) => void | Promise<void>): boolean;
