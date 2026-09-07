import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

describe('Package Load Test', () => {
    let fixtureDir: string;
    let julesTarball: string;
    let commonTarball: string;

    beforeAll(() => {
        const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const commonDir = path.resolve(packageDir, '..', 'common');
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-jules-package-'));
        const packDir = path.join(fixtureDir, 'tarballs');
        fs.mkdirSync(packDir);

        const pack = (cwd: string): string => {
            // pnpm rewrites workspace:^ to a publishable semver range. npm pack
            // preserves the workspace protocol, producing an archive consumers
            // cannot install outside this monorepo.
            execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd, stdio: 'ignore' });
            const tarballs = fs.readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'));
            if (tarballs.length === 0) throw new Error(`pnpm pack did not create a tarball for ${cwd}`);
            return path.resolve(packDir, tarballs[tarballs.length - 1]!);
        };

        commonTarball = pack(commonDir);
        julesTarball = pack(packageDir);

        const manifest = JSON.parse(execFileSync('tar', ['-xOf', julesTarball, 'package/package.json'], { encoding: 'utf-8' })) as {
            dependencies?: Record<string, string>;
        };
        expect(manifest.dependencies?.['@pilleo/paperclip-adapter-common']).toMatch(/^\^\d+\.\d+\.\d+$/);

        execFileSync('npm', [
            'install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
            commonTarball, julesTarball,
        ], { cwd: fixtureDir, stdio: 'ignore' });
    // npm pack runs the adapter's prepack build. Under the workspace suite it
    // competes with coverage workers, so 30 seconds caused a false timeout
    // before the package-load assertion even ran.
    }, 120000);

    afterAll(() => {
        if (fixtureDir && fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('loads the packed adapter factory conforming to Paperclip external adapter expectations', async () => {
        const entrypoint = path.join(
            fixtureDir,
            'node_modules',
            '@pilleo',
            'paperclip-jules-adapter',
            'dist',
            'index.js',
        );
        expect(fs.existsSync(entrypoint)).toBe(true);
        const imported = await import(pathToFileURL(entrypoint).href);

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
