// Mounts allowlist persistence.
//
// File location and schema must match the orchestrator's reader. The
// canonical schema is defined in `nanoclaw/src/types.ts`:
//
//   interface AllowedRoot { path: string; allowReadWrite: boolean; description?: string }
//   interface MountAllowlist {
//     allowedRoots: AllowedRoot[]
//     blockedPatterns: string[]
//     nonMainReadOnly: boolean
//   }
//
// The CLI's step 04 shells out to `npx tsx setup/index.ts --step mounts`
// (which writes the canonical shape with allowedRoots: []). We write
// the same shape directly. Includes a tolerant reader that handles the
// (legacy) bare-string shape so files written by older wizard builds
// don't crash the renderer.

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AllowedRoot, MountAllowlist } from '../../shared/types'

export const MOUNT_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'mount-allowlist.json'
)

function defaultAllowlist(): MountAllowlist {
  return { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true }
}

// Tolerant coercion of an unknown shape into AllowedRoot. Migrates legacy
// `string[]` entries (which a buggy version of this wizard briefly wrote)
// into the canonical object form. Returns null if the value can't be
// understood at all.
function coerceAllowedRoot(raw: unknown): AllowedRoot | null {
  if (typeof raw === 'string') {
    return { path: raw, allowReadWrite: true }
  }
  if (raw && typeof raw === 'object' && typeof (raw as AllowedRoot).path === 'string') {
    const obj = raw as Partial<AllowedRoot>
    return {
      path: obj.path as string,
      allowReadWrite: obj.allowReadWrite !== false, // default true
      description: typeof obj.description === 'string' ? obj.description : undefined
    }
  }
  return null
}

export async function readMountAllowlist(): Promise<MountAllowlist> {
  try {
    const raw = await fs.promises.readFile(MOUNT_ALLOWLIST_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MountAllowlist> & {
      allowedRoots?: unknown[]
    }
    const allowedRoots = Array.isArray(parsed.allowedRoots)
      ? (parsed.allowedRoots
          .map(coerceAllowedRoot)
          .filter((r): r is AllowedRoot => r !== null))
      : []
    return {
      allowedRoots,
      blockedPatterns: Array.isArray(parsed.blockedPatterns)
        ? (parsed.blockedPatterns as string[])
        : [],
      nonMainReadOnly: parsed.nonMainReadOnly ?? true
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultAllowlist()
    }
    throw err
  }
}

export async function writeMountAllowlist(allowlist: MountAllowlist): Promise<void> {
  // Defensive coerce on the way out — guarantees the file matches the
  // canonical shape even if the renderer accidentally posts an entry
  // missing `allowReadWrite`.
  const normalized: MountAllowlist = {
    allowedRoots: allowlist.allowedRoots
      .map(coerceAllowedRoot)
      .filter((r): r is AllowedRoot => r !== null),
    blockedPatterns: allowlist.blockedPatterns ?? [],
    nonMainReadOnly: allowlist.nonMainReadOnly ?? true
  }
  await fs.promises.mkdir(path.dirname(MOUNT_ALLOWLIST_PATH), {
    recursive: true,
    mode: 0o700
  })
  await fs.promises.writeFile(
    MOUNT_ALLOWLIST_PATH,
    JSON.stringify(normalized, null, 2) + '\n',
    { mode: 0o600 }
  )
}
