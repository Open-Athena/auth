/**
 * `@open-athena/auth/provider`: a small OpenID Connect provider over a gate,
 * for a broker deployment that signs people in once for a fixed set of apps
 * (`specs/oidc-provider.md`). The D1 store is `@open-athena/auth/provider/d1`
 * (migration `migrations/provider/`); apps sign in through it with
 * `@open-athena/auth/oidc` and `brokerProvider(issuer)`.
 */
export { generateSigningKey, keySet } from './keys.js';
export { brokerProvider, hashClientSecret, oidcProviderRoutes } from './routes.js';
export { memoryProviderStore } from './store.js';
