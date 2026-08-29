import { SessionPhaseSchema } from './session.js';
import { z } from 'zod';

type SessionPhase = z.infer<typeof SessionPhaseSchema>;

export interface StateMachineResult {
  nextPhase: SessionPhase;
  requiresReturn: boolean;
  isTerminal: boolean;
  clearSession: boolean;
  isSuccess?: boolean;
}

export function handleJulesState(julesState: string, hasPrUrl: boolean): StateMachineResult {
  switch (julesState) {
    case 'QUEUED':
    case 'PLANNING':
    case 'IN_PROGRESS':
      return {
        nextPhase: 'RUNNING',
        requiresReturn: false,
        isTerminal: false,
        clearSession: false
      };

    case 'PAUSED':
      // Operator paused/archived the session; terminal reset to allow fresh start
      return {
        nextPhase: 'STARTING',
        requiresReturn: true,
        isTerminal: true,
        clearSession: true
      };

    case 'AWAITING_USER_FEEDBACK':
      return {
        nextPhase: 'WAITING_FOR_FEEDBACK',
        requiresReturn: true, // Needs to return interaction to Paperclip
        isTerminal: false,
        clearSession: false
      };

    case 'AWAITING_PLAN_APPROVAL':
      return {
        nextPhase: 'WAITING_FOR_PLAN_APPROVAL',
        requiresReturn: true, // Needs to return interaction to Paperclip
        isTerminal: false,
        clearSession: false
      };

    case 'COMPLETED':
      return {
        nextPhase: 'COMPLETED',
        requiresReturn: true,
        isTerminal: true,
        clearSession: true, // Clear session on terminal success
        isSuccess: hasPrUrl // Only true success if PR was created
      };

    case 'FAILED':
      return {
        nextPhase: 'FAILED',
        requiresReturn: true,
        isTerminal: true, // It's terminal from the Jules side, retry policy decides if we start a new one
        clearSession: false // Do not clear, we need state for retry
      };

    default:
      // Unknown states
      return {
        nextPhase: 'RUNNING',
        requiresReturn: false,
        isTerminal: false,
        clearSession: false
      };
  }
}
