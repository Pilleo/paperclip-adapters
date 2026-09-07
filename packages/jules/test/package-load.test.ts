import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const execFileAsync = promisify(execFile);
const PACKAGE_CONTRACT_TIMEOUT_MS = 300_000;

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

    beforeAll(async () => {
        const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const commonDir = path.resolve(packageDir, '..', 'common');
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-jules-package-'));
        const packDir = path.join(fixtureDir, 'tarballs');
        fs.mkdirSync(packDir);

        const pack = async (cwd: string): Promise<string> => {
            // pnpm rewrites workspace:^ to a publishable semver range. npm pack
            // preserves the workspace protocol, producing an archive consumers
            // cannot install outside this monorepo.
            await execFileAsync('pnpm', ['pack', '--pack-destination', packDir], {
                cwd,
                timeout: PACKAGE_CONTRACT_TIMEOUT_MS,
            });
            const tarballs = fs.readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'));
            if (tarballs.length === 0) throw new Error(`pnpm pack did not create a tarball for ${cwd}`);
            return path.resolve(packDir, tarballs[tarballs.length - 1]!);
        };

        commonTarball = await pack(commonDir);
        julesTarball = await pack(packageDir);

        const { stdout: packedManifest } = await execFileAsync('tar', ['-xOf', julesTarball, 'package/package.json'], {
            encoding: 'utf-8',
            timeout: PACKAGE_CONTRACT_TIMEOUT_MS,
        });
        const manifest = JSON.parse(packedManifest) as {
            dependencies?: Record<string, string>;
        };
        expect(manifest.dependencies?.['@pilleo/paperclip-adapter-common']).toMatch(/^\^\d+\.\d+\.\d+$/);

        await execFileAsync('npm', [
            'install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
            commonTarball, julesTarball,
        ], { cwd: fixtureDir, timeout: PACKAGE_CONTRACT_TIMEOUT_MS });
    // This is a packaging integration contract, not an in-process unit hook:
    // it builds two publishable archives and installs their dependency graph.
    // Await subprocesses so Vitest's worker RPC remains responsive while the
    // full monorepo runs concurrently, and retain a finite CI failure bound.
    }, PACKAGE_CONTRACT_TIMEOUT_MS);

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
