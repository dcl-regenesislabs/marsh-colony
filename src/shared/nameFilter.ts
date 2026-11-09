// Pet name rules, shared by the client (instant feedback) and the server (the
// real gate, since names are shown to other players). Word lists live in
// nameBlocklist.ts.

import { BLOCKED_ANYWHERE, BLOCKED_WORDS } from './nameBlocklist'

export const PET_NAME_MAX = 12

export type PetNameProblem = 'tooLong' | 'blocked'

const FOLD: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n',
  // Common letter look-alikes ("f4gg0t", "$hit").
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i'
}

/** Lowercase, accents and look-alikes folded; split into letter-only words. */
function words(text: string): string[] {
  let folded = ''
  for (const ch of text.toLowerCase()) folded += FOLD[ch] ?? ch
  return folded.split(/[^a-z]+/).filter(Boolean)
}

const collapse = (s: string): string => s.replace(/(.)\1+/g, '$1')
// Only collapse when someone stretched a word ("fuuuuck"), so real double
// letters ("Bobbi" vs "boobs") are never folded together.
const stretched = (s: string): boolean => /(.)\1\1/.test(s)

const anywhere = BLOCKED_ANYWHERE.map((w) => words(w).join('')).filter(Boolean)
const anywhereCollapsed = anywhere.map(collapse)
const singles = new Set<string>()
const phrases: string[] = []
const symbols: string[] = []
for (const entry of BLOCKED_WORDS) {
  const parts = words(entry)
  if (parts.length === 0) symbols.push(entry) // e.g. an emoji
  else if (parts.length === 1) singles.add(parts[0])
  else phrases.push(parts.join(''))
}
const singlesCollapsed = new Set([...singles].map(collapse))

/** True when the name contains a blocked word, ignoring case, accents,
 *  look-alike characters, separators ("f.u.c.k") and stretched letters. */
export function isBlockedName(name: string): boolean {
  if (symbols.some((s) => name.includes(s))) return true
  const tokens = words(name)
  const flat = tokens.join('')
  if (!flat) return false
  const flatStretched = stretched(flat)
  for (let i = 0; i < anywhere.length; i++) {
    if (flat.includes(anywhere[i])) return true
    if (flatStretched && collapse(flat).includes(anywhereCollapsed[i])) return true
  }
  if (phrases.some((p) => flat.includes(p))) return true
  // Whole words, plus the whole name glued together ("F U C K", "a.s.s").
  for (const candidate of [...tokens, flat]) {
    if (singles.has(candidate)) return true
    if (stretched(candidate) && singlesCollapsed.has(collapse(candidate))) return true
  }
  return false
}

/** Why a typed pet name can't be used, or null when it's fine. An empty name
 *  is not a problem here: callers fall back to the species name. */
export function petNameProblem(name: string): PetNameProblem | null {
  const trimmed = name.trim()
  if (trimmed.length > PET_NAME_MAX) return 'tooLong'
  if (isBlockedName(trimmed)) return 'blocked'
  return null
}
