/** The user's home folder. Windows has no HOME, only USERPROFILE: paths built from an unset HOME came out as
    `undefined/.claude/...`, which made the tagging and stop hooks throw (and the log land in `./undefined/.claude`). */
export function homeOf(env: { HOME?: string; USERPROFILE?: string }): string {
  const home = env.HOME || env.USERPROFILE
  if (!home) throw new Error('neither HOME nor USERPROFILE is set, so the .claude folder cannot be found')
  return home
}

/** Where a Linux program (grep, dd, mv, mkdir, rm, find) lives on Windows: Git for Windows ships them in usr\bin, which is
    usually not on the PATH (and a `find` found there first would be Windows' own, different find.exe). Tried under each
    install root in order; undefined when none has it. */
export async function gitToolPath(name: string, roots: readonly (string | undefined)[], exists: (path: string) => Promise<boolean>): Promise<string | undefined> {
  for (const root of roots) {
    if (!root) continue
    const path = `${root}\\Git\\usr\\bin\\${name}.exe`
    if (await exists(path)) return path
  }
  return undefined
}
