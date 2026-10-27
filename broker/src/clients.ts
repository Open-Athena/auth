/**
 * The apps that may sign people in through this broker. Adding one is a
 * reviewed change here: an id, `hashClientSecret(secret)` (the secret itself
 * goes only to that app), and its exact callback URLs.
 */
import type { ProviderClient } from '@open-athena/auth/provider'

export const clients: ProviderClient[] = []
