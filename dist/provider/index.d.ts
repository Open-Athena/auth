/**
 * `@open-athena/auth/provider`: a small OpenID Connect provider over a gate,
 * for a broker deployment that signs people in once for a fixed set of apps
 * (`specs/oidc-provider.md`). The D1 store is `@open-athena/auth/provider/d1`
 * (migration `migrations/provider/`); apps sign in through it with
 * `@open-athena/auth/oidc` and `brokerProvider(issuer)`.
 */
export { generateSigningKey, keySet, type KeySet, type PublicJwk, type SigningJwk } from './keys.js';
export { brokerProvider, type ClaimsInput, hashClientSecret, oidcProviderRoutes, type ProviderClient, type ProviderOptions } from './routes.js';
export { type CodeRecord, memoryProviderStore, type ProviderStore } from './store.js';
