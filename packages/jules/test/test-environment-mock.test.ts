import { describe, it, expect, vi } from 'vitest';
import { testEnvironment } from '../src/server/test-environment';

vi.mock('../src/server/jules-client');

  describe('testEnvironment Configuration Diagnostics', () => {
   it('fails gracefully logging available keys for missing configurations', async () => {
       const res = await testEnvironment({
           companyId: "comp-1",
           adapterType: "jules",
           config: { // Emulating what paperclip actually passes
               foo: "bar"
           }
       });
       expect(res.status).toBe('fail');
       expect(res.checks[0]!.message).toContain('configuration is invalid');
       expect(res.checks[0]!.message).toContain('Received config keys: foo');
   });

   it('fails gracefully logging available keys when nested under adapterSchemaValues', async () => {
       const res = await testEnvironment({
           companyId: "comp-1",
           adapterType: "jules",
           config: {
               adapterSchemaValues: { foo: "bar" }
           }
       });
       expect(res.status).toBe('fail');
       expect(res.checks[0]!.message).toContain('configuration is invalid');
       expect(res.checks[0]!.message).toContain('Received config keys: foo');
   });
});
