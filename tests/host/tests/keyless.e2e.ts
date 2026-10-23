/**
 * Keyless public dsh profile E2E: a deterministic LLM adapter, real Agent,
 * durable Session, Loader composition and ANSI terminal subprocess.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../../../../../../', import.meta.url))
const cli = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const config = fileURLToPath(new URL('../fixtures/cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const launch = resolveExampleLaunch({ srcBin: cli, mode: 'src', sourceImport: 'tsx/esm', tsconfigPath: tsconfig })

describe('shipped dsh tui profile: keyless real-Agent ANSI subprocess', () => {
  it('submits two turns, handles an injected stream failure, and flushes its Session on exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-real-profile-'))
    const persisted = join(dir, 'sessions')
    const child = execa(launch.command, [
      ...launch.args, '--profile', 'tui', '--patch', config, '--no-native',
    ], {
      cwd: root,
      env: {
        ...launch.env,
        DSH_HOME: join(dir, 'home'),
        DSH_TUI_TEST_STORE: persisted,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'danger-full-access',
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: undefined,
      },
      timeout: 60_000, reject: false, killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const waitFor = async (text: string): Promise<void> => {
      const deadline = Date.now() + 25_000
      while (!stdout.includes(text)) {
        if (Date.now() > deadline) throw new Error('missing ' + text + '; stdout=' + stdout + '; stderr=' + stderr)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    try {
      await waitFor('dsh TUI (ANSI)')
      child.stdin.write('alpha\n')
      await waitFor('[dsh] echo: alpha')
      child.stdin.write('beta\n')
      await waitFor('[dsh] echo: beta')
      child.stdin.write('[failure]\n')
      await waitFor('intentional keyless fixture stream failure')
      child.stdin.write('/quit\n')
      const result = await child
      expect(result.exitCode, stderr).toBe(0)
      expect(stdout).toContain('[you] alpha')
      expect(stdout).toContain('[you] beta')
      const paths = await readdir(persisted, { recursive: true })
      expect(paths.some(path => path.endsWith('.jsonl'))).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await child.catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
