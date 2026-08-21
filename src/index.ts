export { b64uDecodeBytes, b64uDecodeString, b64uEncode } from './core/base64.js'
export { nullAudit, requestMeta } from './core/audit.js'
export {
  MAX_INLINE_AVATAR_BYTES,
  githubAvatarUrl,
  gravatarUrl,
  isGithubHandle,
  isSafeAvatarUrl,
  resolveAvatar,
} from './core/avatar.js'
export type { AvatarSource, ResolveAvatarOptions } from './core/avatar.js'
export type { AccessEvent, AccessEventKind, AuditSink, RequestMeta } from './core/audit.js'
export { isBot, isVerifiedBot, looksAutomated } from './core/bots.js'
export { ALL_SCOPES, canRedeem, createGate, isActive, sessionValid } from './core/gate.js'
export type { Gate, GateOptions, MintResult, RedeemFailure, RedeemResult, RequestAccessResult } from './core/gate.js'
export { DEFAULT_RATE_LIMIT, MAX_SUBJECT_FIELD, cleanSubject, isEmailish, noopNotify, subjectName } from './core/requests.js'
export type { AccessRequest, Notify, NotifyEvent, RateLimit, RequestStatus } from './core/requests.js'
export { authRoutes } from './core/routes.js'
export type { RouteOptions } from './core/routes.js'
export { adminPolicy, anyEmailPolicy, domainPolicy, firstMatch } from './core/policy.js'
export type { EmailPolicy } from './core/policy.js'
export {
  DEFAULT_COOKIE_NAME,
  DEFAULT_SESSION_TTL_S,
  clearCookie,
  emailSub,
  grantSub,
  isSecureRequest,
  parseSub,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from './core/session.js'
export type { CookieOpts, SessionClaims } from './core/session.js'
export type {
  AuditQuery,
  GrantActivity,
  GrantDraft,
  GrantListOpts,
  GrantStore,
  RequestListOpts,
  RequestStore,
  StoredEvent,
} from './core/store.js'
export { generateId, generateToken, hashIp, hashToken } from './core/tokens.js'
export { formatScopes, hasScope, parseScopes } from './core/types.js'
export type { Auth, Grant, NewGrant, GrantPatch, Subject } from './core/types.js'
