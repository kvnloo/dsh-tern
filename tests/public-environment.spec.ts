import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publicEnvironment } from '../scripts/public-environment.mjs'

describe('public gate environment', () => {
  it('forces noninteractive CI without leaking arbitrary host variables', () => {
    const environment = publicEnvironment('/private/gate', {
      PATH: '/bin', LANG: 'C.UTF-8', CI: 'false', HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/config', DSH_HOME: '/host/dsh',
      OPENAI_API_KEY: 'must-not-leak', NODE_OPTIONS: '--inspect', PNPM_HOME: '/host/pnpm',
    })
    expect(environment).toEqual({
      PATH: '/bin', LANG: 'C.UTF-8', CI: 'true',
      HOME: join('/private/gate', 'home'),
      XDG_CONFIG_HOME: join('/private/gate', 'config'),
      XDG_CACHE_HOME: join('/private/gate', 'cache'),
      DSH_HOME: join('/private/gate', 'dsh'),
      DSH_AGENTS_HOME: join('/private/gate', 'agents'),
      DSH_TELEMETRY_DISABLED: '1', TERM: 'xterm-256color',
    })
  })
})
