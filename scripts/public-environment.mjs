import { join } from 'node:path'

export function publicEnvironment(privateRoot, hostEnvironment = process.env) {
  return {
    ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TMPDIR', 'TZ']
      .flatMap(key => hostEnvironment[key] ? [[key, hostEnvironment[key]]] : [])),
    CI: 'true',
    HOME: join(privateRoot, 'home'),
    XDG_CONFIG_HOME: join(privateRoot, 'config'),
    XDG_CACHE_HOME: join(privateRoot, 'cache'),
    DSH_HOME: join(privateRoot, 'dsh'),
    DSH_AGENTS_HOME: join(privateRoot, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  }
}
