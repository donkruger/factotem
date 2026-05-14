#!/usr/bin/env node

/**
 * Release script for claw-setup-gui.
 *
 * Usage (run from inside cli/claw-setup-gui):
 *   npm run release            # patch  (0.1.0 → 0.1.1)
 *   npm run release -- minor   # minor  (0.1.0 → 0.2.0)
 *   npm run release -- major   # major  (0.1.0 → 1.0.0)
 *
 * What it does:
 *   1. Verifies the working tree is clean.
 *   2. Bumps the version in this package's package.json.
 *   3. Commits the bump, tags as `wizard-vN.N.N`, pushes both.
 *   4. The `wizard-v*` tag push triggers
 *      `.github/workflows/release-wizard.yml`, which builds + signs +
 *      notarises the DMG and creates the GitHub release on the public
 *      mirror (RichardBNel/Factotem) via MIRROR_REPO_TOKEN.
 *
 * The script deliberately does NOT call `gh release create` locally —
 * that's the workflow's job. Matches the convention used by the
 * sibling Doctor pipeline at .github/workflows/release.yml.
 */

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd) => execSync(cmd, { cwd: packageDir, stdio: 'inherit' })
const runSilent = (cmd) =>
  execSync(cmd, { cwd: packageDir, encoding: 'utf8' }).trim()

const bump = process.argv[2] || 'patch'
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Invalid bump type: ${bump} (use patch | minor | major)`)
  process.exit(1)
}

// 1. Working tree must be clean.
const status = runSilent('git status --porcelain')
if (status) {
  console.error('Uncommitted changes detected. Commit or stash first.')
  console.error(status)
  process.exit(1)
}

// 2. Bump the version (scoped to this package's package.json).
run(`npm version ${bump} --no-git-tag-version`)
const { version } = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8')
)
const tag = `wizard-v${version}`
console.log(`\n>> Version: ${tag}`)

// 3. Commit, tag, push.
run('git add package.json package-lock.json')
run(`git commit -m "chore(wizard): bump version to ${tag}"`)
run(`git tag "${tag}"`)
run('git push origin main')
run(`git push origin "${tag}"`)
console.log(`\n>> Pushed tag ${tag}. CI is now building macOS binaries.`)
console.log(`   Watch progress: gh run list --limit 3`)
console.log(`   Release will appear at: https://github.com/RichardBNel/Factotem/releases`)
