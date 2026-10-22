const PATH_FIELDS = ['file_path', 'notebook_path', 'path']
const TOKEN = /\*\*\/|\*\*|\*|\?|[\\.^$+{}()|[\]]/g
const TRANSLATION: Record<string, string> = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' }

/** Glob: star within a segment, double star across segments, double star + slash for any directories or none, ? for one character; the whole text must match. */
export function globMatches(text: string, pattern: string): boolean {
  const body = pattern.replaceAll('\\', '/').replace(TOKEN, token => TRANSLATION[token] ?? `\\${token}`)
  return new RegExp(`^${body}$`).test(text.replaceAll('\\', '/'))
}

const pathsOf = (input: unknown): string[] =>
  typeof input === 'object' && input !== null
    ? PATH_FIELDS.map(field => (input as Record<string, unknown>)[field]).filter((v): v is string => typeof v === 'string' && v !== '')
    : []

/** A tool call is protected when its name matches a tool pattern or any file it addresses matches a file pattern. */
export const isProtected = (tool: string, input: unknown, toolPatterns: readonly string[], filePatterns: readonly string[]) =>
  toolPatterns.some(p => globMatches(tool, p)) || pathsOf(input).some(path => filePatterns.some(p => globMatches(path, p)))
