// Uploads this version's installers to its GitHub release: `npm run release` on Windows, `npm run release:mac` on a Mac.
// electron-builder alone gets two things wrong for us, so the release is made here first:
// - with no release yet, the arm64 and x64 uploads each try to create it at once; one fails and its files
//   (latest-mac.yml among them) never arrive. With the release already there, both just upload.
// - it skips, with only a warning, a release published more than two hours ago. Windows and Mac are built on
//   different machines, often hours apart, so the second one would be left out. EP_GH_IGNORE_TIME lifts that.
const { spawnSync, execFileSync } = require('node:child_process')
const path = require('node:path')

const pkg = require('./package.json')
const { owner, repo } = pkg.build.publish[0]
const tag = `v${pkg.version}`
const platform = process.argv[2]
const TARGETS = { win: ['--win', 'nsis'], mac: ['--mac'] }

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

async function github(method, route, body) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) return null
  if (!res.ok) fail(`GitHub ${method} ${route}: ${res.status} ${await res.text()}`)
  return res.json()
}

function git(...args) {
  return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim()
}

async function ensureRelease() {
  const existing = await github('GET', `/releases/tags/${tag}`)
  if (existing) {
    if (existing.draft) fail(`${tag} is a draft; publish it or delete it first`)
    console.log(`release: ${tag} exists, adding to it`)
    return
  }
  // the tag is made on GitHub from this commit, so it has to be there already
  const commit = git('rev-parse', 'HEAD')
  if (!(await github('GET', `/commits/${commit}`))) fail(`push ${commit.slice(0, 7)} before releasing it`)
  await github('POST', '/releases', { tag_name: tag, target_commitish: commit, name: `ELOP Crew ${pkg.version}` })
  console.log(`release: created ${tag} at ${commit.slice(0, 7)}`)
}

async function main() {
  if (!TARGETS[platform]) fail('usage: node release.cjs win|mac')
  if (!process.env.GH_TOKEN) fail('GH_TOKEN is needed: a token that may write releases')
  await ensureRelease()
  const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js')
  const run = spawnSync(process.execPath, [cli, ...TARGETS[platform], '--publish', 'always'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, EP_GH_IGNORE_TIME: 'true' },
  })
  process.exit(run.status ?? 1)
}

main()
