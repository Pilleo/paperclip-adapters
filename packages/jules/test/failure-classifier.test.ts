import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from '../src/server/failure-classifier';
import { JulesClientError } from '../src/server/jules-client';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Failure Classifier and Tools Coverage', () => {
   it('handles generic unidentifiable errors securely', () => {
       expect(classifyFailure({})).toBe('unknown');
   });

   it('handles string errors securely', () => {
       expect(classifyFailure("A weird crash message")).toBe('unknown');
   });

   it('maps to correct error family exhaustively', () => {
       expect(toErrorFamily('transient')).toBe('transient_upstream');
       expect(toErrorFamily('configuration')).toBe(null);
       expect(toErrorFamily('task')).toBe(null);
       expect(toErrorFamily('unknown')).toBe(null);
   });

   beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('summarizeJulesFailure', () => {
      it('returns message if available', () => {
         expect(summarizeJulesFailure({ message: 'A precise crash' })).toBe('A precise crash');
      });

      it('returns status if available', () => {
         expect(summarizeJulesFailure({ status: 'INTERNAL' })).toBe('Jules Error: INTERNAL');
      });

      it('returns code if available', () => {
         expect(summarizeJulesFailure({ code: 500 })).toBe('Jules Error Code: 500');
      });

      it('returns explicit failure for empty objects', () => {
         expect(summarizeJulesFailure({})).toBe('Explicit Jules Failure');
      });
   });

   beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Jules API raw payloads parsing classification checks', () => {
      it('classifies auth status correctly', () => {
         expect(classifyFailure({ status: 'UNAUTHENTICATED' })).toBe('configuration');
         expect(classifyFailure({ status: 'PERMISSION_DENIED' })).toBe('configuration');
         expect(classifyFailure({ code: 401 })).toBe('configuration');
         expect(classifyFailure({ code: '403' })).toBe('configuration');
      });
      it('classifies task status correctly', () => {
         expect(classifyFailure({ status: 'INVALID_ARGUMENT' })).toBe('task');
         expect(classifyFailure({ code: 400 })).toBe('task');
      });
      it('classifies transient status correctly', () => {
         expect(classifyFailure({ status: 'UNAVAILABLE' })).toBe('transient');
         expect(classifyFailure({ status: 'INTERNAL' })).toBe('transient');
         expect(classifyFailure({ code: 429 })).toBe('transient');
         expect(classifyFailure({ code: 503 })).toBe('transient');
         expect(classifyFailure({ code: 500 })).toBe('transient');
      });
   });
});
