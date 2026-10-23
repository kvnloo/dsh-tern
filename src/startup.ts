/**
 * Per-profile CLI provider. The launcher owns --profile; this plugin owns
 * TUI-specific flags and publishes its values as an injected Cordis service.
 */
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
/** Cordis key for the profile-owned, parsed terminal-launch options. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** Values published by the TUI-only CLI provider; the launcher still owns profile selection. */
export interface TuiStartupValues {
  /** Exact existing persistent Session id to adopt; absent means a fresh session. */
  sessionId?: string
  /** Whether to probe Tern; false forces the ordinary ANSI renderer. */
  native: boolean
}

export function apply(ctx: Context): void {
  const command = new Command()
    .name('dsh --profile tui')
    .description('Interactive, session-backed terminal UI; Tern native surface when available, ANSI otherwise.')
    .helpOption('-h, --help', 'show TUI help')
    .option('--no-native', 'use the line-oriented ANSI TUI even inside Tern')
    .option('--session-id <id>', 'resume this exact persisted Session')
    .addHelpText('after', '\nExamples:\n  dsh tui\n  dsh tui --no-native\n  dsh tui --session-id session-...\n')
  command.action(() => {
    const options = command.opts<{ sessionId?: string; native: boolean }>()
    if (options.sessionId !== undefined && options.sessionId.trim() === '') {
      command.error('--session-id requires a non-empty Session id')
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      native: options.native !== false,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, command)
}
