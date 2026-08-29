import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Package Load Test', () => {
    let tgzPath: string;
    let extractDir: string;

    beforeAll(() => {
        // Run npm pack
        const output = execSync('npm pack', { encoding: 'utf-8' }).trim();
        const tarballName = output.split('\n').pop()!;
        tgzPath = path.resolve(process.cwd(), tarballName);

        // Extract to a temp dir
        extractDir = path.resolve(process.cwd(), 'temp-test-extract');
        if (!fs.existsSync(extractDir)) {
            fs.mkdirSync(extractDir);
        }
        execSync(`tar -xzf ${tgzPath} -C ${extractDir}`);
    }, 30000);

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(tgzPath)) {
            fs.unlinkSync(tgzPath);
        }
        if (fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
    });

    it('loads the packed adapter factory conforming to Paperclip external adapter expectations', async () => {
        // Dynamically import the extracted module's main entry point
        const modulePath = path.resolve(extractDir, 'package', 'dist', 'index.js');
        const imported = await import(modulePath);

        expect(imported.type).toBe('jules');
        expect(imported.createServerAdapter).toBeDefined();
        expect(typeof imported.createServerAdapter).toBe('function');

        const adapter = imported.createServerAdapter();
        expect(adapter.type).toBe('jules');
        expect(adapter.execute).toBeDefined();
        expect(adapter.testEnvironment).toBeDefined();
        expect(adapter.sessionCodec).toBeDefined();
    });
});
