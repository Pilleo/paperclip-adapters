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
    let commonTgzPath: string;

    beforeAll(() => {
        const pilleoRoot = process.cwd(); // Assume tests are run from repo root when via npm test workspace
        const julesRoot = pilleoRoot.endsWith('packages/jules') ? pilleoRoot : path.resolve(pilleoRoot, 'packages/jules');
        const commonRoot = pilleoRoot.endsWith('packages/jules') ? path.resolve(pilleoRoot, '../common') : path.resolve(pilleoRoot, 'packages/common');

        // Run npm pack
        const output = execSync('npm pack', { encoding: 'utf-8', cwd: julesRoot }).trim();
        const tarballName = output.split('\n').pop()!;
        tgzPath = path.resolve(julesRoot, tarballName);

        // Extract to a temp dir
        extractDir = path.resolve(julesRoot, 'temp-test-extract');
        if (!fs.existsSync(extractDir)) {
            fs.mkdirSync(extractDir);
        }
        execSync(`tar -xzf ${tgzPath} -C ${extractDir}`);

        // Remove workspace dependencies so npm install works in the extracted dir
        const pkgJsonPath = path.resolve(extractDir, 'package', 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            if (pkgData.dependencies && pkgData.dependencies['@pilleo/paperclip-adapter-common'] === 'workspace:*') {
                delete pkgData.dependencies['@pilleo/paperclip-adapter-common'];
                fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgData, null, 2));
            }
        }

        // Mock workspace install for the extracted package
        const commonOutput = execSync('npm pack', { encoding: 'utf-8', cwd: commonRoot }).trim();
        const commonTgz = commonOutput.split('\n').pop()!;
        commonTgzPath = path.resolve(commonRoot, commonTgz);
        execSync(`npm install --no-save ${commonTgzPath}`, { cwd: path.resolve(extractDir, 'package') });
    }, 30000);

    afterAll(() => {
        // Cleanup
        if (fs.existsSync(tgzPath)) {
            fs.unlinkSync(tgzPath);
        }
        if (fs.existsSync(commonTgzPath)) {
            fs.unlinkSync(commonTgzPath);
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
