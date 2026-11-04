import type { Dollar } from './register'

/** A child to start, never through a shell: on Windows every value reaches PowerShell through `env`, not quoted into its
    script. `shown` is how errors name it. */
export type Child = { argv: string[]; env: Record<string, string>; shown: string }

async function isWindows($: Dollar) {
  return (await $.env.get('OS')) === 'Windows_NT'
}

/** Claude Code's own folder, found as Claude Code finds it: CLAUDE_CONFIG_DIR, else `.claude` in the home folder that
    Node's os.homedir() reads, USERPROFILE on Windows and HOME elsewhere. */
export async function claudeDir($: Dollar): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return config
  const windows = await isWindows($)
  const home = windows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  if (!home) throw new Error(`cannot find the home folder: ${windows ? 'USERPROFILE' : 'HOME'} is unset`)
  return `${home}/.claude`
}

/** Starts the child in Claude Code's own folder, which exists while it runs. A child inherits the session's cwd otherwise,
    and cannot start (ENOENT) once that directory is gone, as a removed worktree is; every path passed to a child is absolute. */
export async function exec($: Dollar, child: Child, init: { stdin?: string; timeoutMs?: number } = {}) {
  return $.process.run(child.argv, { ...init, cwd: await claudeDir($), env: child.env })
}

export async function run($: Dollar, child: Child) {
  const { exitCode, stderr } = await exec($, child)
  if (exitCode !== 0) throw new Error(`${child.shown} failed: exit ${exitCode}, ${stderr}`)
}

const TITLE = '"aiTitle":"[^"]*"'
const API_REQUEST = '{"type":"api-request'

const unix = (...argv: string[]): Child => ({ argv, env: {}, shown: argv.join(' ') })

/** Every outside command dcp runs. Exit codes follow grep's: 1 when `titles` finds none, 2 on any failure. */
const UNIX = {
  mkdir: (dir: string) => unix('mkdir', '-p', dir),
  /** Moves a file or folder into the folder `to`. */
  move: (from: string, to: string) => unix('mv', from, `${to}/`),
  /** Deletes files and folders; a missing one is no error. */
  remove: (paths: string[]) => unix('rm', '-rf', '--', ...paths),
  /** Deletes the files under `dir` last written more than `minutes` ago. */
  removeOlder: (dir: string, minutes: number) => unix('find', dir, '-type', 'f', '-mmin', `+${minutes}`, '-delete'),
  /** Prints every `"aiTitle":"..."` in `file`, one per line. */
  titles: (file: string) => unix('grep', '-o', '-E', TITLE, file),
  /** Prints `file` without its per-request API log lines. */
  readTranscript: (file: string) => unix('grep', '-v', '-e', `^${API_REQUEST}`, file),
  /** Writes standard input to `file`, byte for byte. */
  writeTranscript: (file: string) => unix('dd', `of=${file}`, 'status=none'),
}

/** PowerShell's -EncodedCommand: the script as base64 of its UTF-16LE, so no quoting rule of the Windows command line touches it. */
const encode = (script: string) => btoa(script.split('').map(c => String.fromCharCode(c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8)).join(''))

// Windows PowerShell 5.1 ships with every Windows Claude Code runs on; it starts by its full path, since a bare name is looked up
// in the cwd first. Text crosses its console streams as raw UTF-8 bytes through .NET streams, since PowerShell's own pipes
// re-encode it; `trap` turns any failed step into exit 2. Paths go to .NET or to -LiteralPath, never to a wildcard pattern.
const UTF8 = '[Text.UTF8Encoding]::new($false)'
const ps = (exe: string, shown: string, script: string, env: Record<string, string>): Child => ({
  argv: [exe, '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $e = [IO.StreamWriter]::new([Console]::OpenStandardError(), ${UTF8}); trap { $e.WriteLine($_); $e.Flush(); exit 2 }; ${script}`)],
  env,
  shown: `powershell ${shown} ${Object.values(env).join(' ')}`,
})
const UTF8_OUT = `$w = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), ${UTF8});`

function windows(exe: string): typeof UNIX {
  return {
    mkdir: dir => ps(exe, 'mkdir', '[IO.Directory]::CreateDirectory($env:DCP_PATH) | Out-Null', { DCP_PATH: dir }),
    move: (from, to) =>
      ps(exe, 'move', '$d = [IO.Path]::Combine($env:DCP_TO, [IO.Path]::GetFileName($env:DCP_FROM)); if ([IO.Directory]::Exists($env:DCP_FROM)) { [IO.Directory]::Move($env:DCP_FROM, $d) } else { [IO.File]::Move($env:DCP_FROM, $d) }', { DCP_FROM: from, DCP_TO: to }),
    remove: paths => ps(exe, 'remove', 'foreach ($p in $env:DCP_PATHS -split [char]10) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }', { DCP_PATHS: paths.join('\n') }),
    removeOlder: (dir, minutes) =>
      ps(exe, 'removeOlder', '$cut = (Get-Date).AddMinutes(-[int]$env:DCP_MINUTES); Get-ChildItem -LiteralPath $env:DCP_PATH -File -Recurse -Force | Where-Object { $_.LastWriteTime -lt $cut } | Remove-Item -Force', { DCP_PATH: dir, DCP_MINUTES: String(minutes) }),
    titles: file =>
      ps(exe, 'titles', `${UTF8_OUT} $m = Select-String -LiteralPath $env:DCP_PATH -Pattern $env:DCP_PATTERN -CaseSensitive -AllMatches -Encoding UTF8; if (-not $m) { exit 1 }; foreach ($v in $m.Matches.Value) { $w.Write($v + [char]10) }; $w.Flush()`, { DCP_PATH: file, DCP_PATTERN: TITLE }),
    readTranscript: file =>
      ps(exe, 'readTranscript', `${UTF8_OUT} foreach ($l in [IO.File]::ReadLines($env:DCP_PATH)) { if (-not $l.StartsWith($env:DCP_SKIP, [StringComparison]::Ordinal)) { $w.Write($l + [char]10) } }; $w.Flush()`, { DCP_PATH: file, DCP_SKIP: API_REQUEST }),
    writeTranscript: file => ps(exe, 'writeTranscript', '$f = [IO.File]::Create($env:DCP_PATH); [Console]::OpenStandardInput().CopyTo($f); $f.Close()', { DCP_PATH: file }),
  }
}

/** The commands of the platform Claude Code runs on. */
export async function commands($: Dollar): Promise<typeof UNIX> {
  if (!(await isWindows($))) return UNIX
  const root = await $.env.get('SystemRoot')
  if (!root) throw new Error('cannot find PowerShell: SystemRoot is unset')
  return windows(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
}
