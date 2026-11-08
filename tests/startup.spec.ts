/** Real Cordis Loader composition of TUI startup and injected consumer config. */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply, type TuiStartupValues } from '../src/startup.ts'
import { initProfile } from '@deepseek-ai/dsh-app-boot'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function boot(args: string[]): Promise<{
  resolved: TuiStartupValues | undefined
  consumer: TuiStartupValues | undefined
  exits: number[]
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-loader-'))
  const global = globalThis as typeof globalThis & {
    __dshTuiApply?: typeof apply
    __dshTuiConsumer?: TuiStartupValues
  }
  writeFileSync(join(dir, 'start.mjs'), [
    "export const name = 'tui-startup'",
    "export const inject = ['cmdlineArgs']",
    'export function apply(ctx) { globalThis.__dshTuiApply(ctx) }',
  ].join('\n'))
  writeFileSync(join(dir, 'consumer.mjs'), [
    "export const name = 'tui-config-observer'",
    "export const inject = ['tuiStartup']",
    'export function apply(_ctx, config) { globalThis.__dshTuiConsumer = config }',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-startup',
    '  name: ' + pathToFileURL(join(dir, 'start.mjs')).href,
    '- id: tui-consumer',
    '  name: ' + pathToFileURL(join(dir, 'consumer.mjs')).href,
    '  inject: [tuiStartup]',
    '  config:',
    '    sessionId: !!js ctx.tuiStartup.sessionId',
    '    native: !!js ctx.tuiStartup.native',
    '',
  ].join('\n'))
  const ctx = new Context()
  const exits: number[] = []
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
    delete global.__dshTuiApply
    delete global.__dshTuiConsumer
  })
  global.__dshTuiApply = apply
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => { exits.push(code) } })
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  return {
    resolved: ctx.get('tuiStartup') as TuiStartupValues | undefined,
    consumer: global.__dshTuiConsumer,
    exits,
  }
}

describe('shipped TUI profile / ordinary plugin composition', () => {
  it('initializes an ordinary base-only named profile before external plugin installation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-profile-'))
    try {
      // The host supplies the base template. Only the real dsh plugin manager
      // may add and activate the separately packed @kvnloo/dsh-tern layer
      // (covered in the source/lib public PTY gates).
      initProfile(dir, ['@deepseek-ai/dsh-base'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: string[] } }
        dependencies?: Record<string, string>
      }
      expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
      expect(manifest.dependencies?.['@kvnloo/dsh-tern']).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('resolves defaults through a real Loader tree', async () => {
    const result = await boot([])
    expect(result).toMatchObject({
      resolved: { native: true },
      consumer: { native: true },
      exits: [],
    })
  })
  it('passes exact Session identity and explicit ANSI fallback', async () => {
    const result = await boot(['--session-id', 'session-123', '--no-native'])
    expect(result.resolved).toEqual({ sessionId: 'session-123', native: false })
    expect(result.consumer).toMatchObject({ sessionId: 'session-123', native: false })
    expect(result.exits).toEqual([])
  })
})
