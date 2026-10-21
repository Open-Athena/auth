import { createContext } from 'react'
import type { SessionLossReason } from '../core/denial.js'

export const SessionLossContext = createContext<SessionLossReason | null>(null)
