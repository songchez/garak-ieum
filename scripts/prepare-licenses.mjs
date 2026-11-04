import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { repository, repositoryUrl, sourceInfo } from './source-info.mjs'
import { nativeDependencyLock } from './native-dependencies.mjs'

const info = sourceInfo()
const target = path.join(repository, 'public', 'licenses')
await mkdir(target, { recursive: true })
await copyFile(path.join(repository, 'LICENSE'), path.join(target, 'GPL-3.0-only.txt'))

// Preserve the actual installed runtime dependency notices, including transitive
// packages. pnpm supplies npm_execpath when invoked through a package script.
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this script with pnpm licenses:prepare')
const pnpmArguments = ['licenses', 'list', '--prod', '--json']
const pnpmIsScript = /\.[cm]?js$/i.test(pnpm)
const licenses = JSON.parse(execFileSync(pnpmIsScript ? process.execPath : pnpm, pnpmIsScript ? [pnpm, ...pnpmArguments] : pnpmArguments, {
  cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
}))
const dependencies = Object.values(licenses).flat().sort((a, b) => a.name.localeCompare(b.name))
const sections = [await readFile(path.join(repository, 'THIRD_PARTY_NOTICES.md'), 'utf8')]
sections.push('\n## Installed runtime package notices\n\nThese packages retain their respective licenses. Versions are pinned in pnpm-lock.yaml.\n')
for (const dependency of dependencies) {
  for (const directory of dependency.paths) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    const names = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name)).sort()
    if (!names.length) throw new Error(`Missing license notice for ${pkg.name}@${pkg.version}`)
    sections.push(`\n### ${pkg.name}@${pkg.version} (${dependency.license})\n`)
    for (const name of names) sections.push(`\n${name}\n\n${await readFile(path.join(directory, name), 'utf8')}\n`)
  }
}
sections.push('\nElectron, Chromium and Node.js notices are also shipped by Electron in LICENSE.electron.txt and LICENSES.chromium.html beside the installed executable.\n')
const nativeLicenses = path.join(repository, 'build/native-audio/licenses')
if (await access(nativeLicenses).then(() => true, () => false)) {
  sections.push('\n## Desktop native audio dependency notices\n\nThe desktop audio host uses these exact pinned sources. The matching source ZIP includes their original verified archives under native/dependency-sources/.\n')
  for (const dependency of (await nativeDependencyLock()).dependencies) {
    sections.push(`\n### ${dependency.id} ${dependency.version} (${dependency.license})\nSource: ${dependency.url}\nSHA256: ${dependency.sha256}\n`)
    for (const relative of dependency.licenseFiles) sections.push(`\n${dependency.id}/${relative}\n\n${await readFile(path.join(nativeLicenses, dependency.id, relative), 'utf8')}\n`)
  }
}
await writeFile(path.join(target, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n'))

const state = info.origin === 'git'
  ? info.dirty ? '개발 빌드: 기록된 커밋 이후의 로컬 변경이 있습니다.' : '이 빌드는 아래 Git 커밋의 소스로 만들었습니다.'
  : info.origin === 'archive' ? '소스 묶음에 기록된 원본 커밋입니다. 압축을 푼 뒤의 로컬 변경 여부는 확인하지 않습니다.' : '개발 빌드: 소스 커밋이 기록되지 않았습니다.'
const source = `가락이음 ${info.version} — 라이선스와 소스 코드

Copyright (c) 2026 가락이음 contributors
프로그램의 코드 배포 라이선스: GNU General Public License, version 3 only (GPL-3.0-only).
GPL 조건에 따라 수정하고 재배포할 수 있습니다. 관련 법률이 허용하는 범위에서 보증 없이 제공합니다.
전문은 이 폴더의 GPL-3.0-only.txt에 있습니다.
이전 MIT 코드의 저작권·허가 고지는 garak-ieum-MIT-notice.txt에 보존합니다.
외부 코드·아이콘·글꼴·샘플은 각각의 라이선스를 따릅니다. THIRD_PARTY_NOTICES.txt와 각 자산의 고지를 함께 확인하세요.

버전: ${info.version}
커밋: ${info.commit ?? '기록 없음'}
${state}
프로젝트 소스: ${info.commit ? `${repositoryUrl}/tree/${info.commit}` : repositoryUrl}
${info.archive ? `이 원본 커밋의 소스 묶음 파일명: ${info.archive}` : '배포용 소스 묶음: 깨끗한 Git 커밋에서 다시 빌드해야 합니다.'}

공식 CI는 검증한 설치 파일과 같은 다운로드 묶음에 소스 ZIP, 이 안내와 SHA256SUMS.txt(Windows) 또는 SHA256SUMS-macos-arm64.txt(macOS)를 넣습니다.
소스 ZIP은 개발·수정용이며 앱 설치에는 Windows .exe 또는 Apple Silicon Mac .dmg를 사용합니다.
공개 Releases 또는 랜딩에 배포할 때에도 해당 설치 파일 옆에 같은 버전의 소스 묶음을 제공합니다.
소스에서 빌드하는 방법과 도구 버전은 소스의 docs/DESKTOP.md(Windows), docs/MACOS.md(macOS), 배포 조건은 docs/LICENSING.md를 읽으세요.
pnpm-lock.yaml은 JavaScript 의존성을 고정합니다. native/dependencies.lock.json은 ASIO·VST3·miniaudio·JSON 소스의 버전과 SHA256을 고정합니다. 소스 ZIP의 native/dependency-sources/에는 해당 SDK·라이브러리의 검증된 원본 소스 묶음이 들어 있으며 native:build는 이 파일을 먼저 사용합니다.
기존 WASM 모듈의 원본 커밋과 변경 방법은 src/devices/pitch-editor/vendor/README.md에 있습니다.

프로그램 라이선스만을 이유로 사용자가 새로 만든 음악이나 녹음에 GPL이 적용되지는 않습니다.
함께 제공되는 샘플을 사용할 때에는 해당 샘플의 별도 이용 조건을 확인하세요.
`
await writeFile(path.join(target, 'SOURCE.txt'), source)
await writeFile(path.join(target, 'SOURCE.json'), `${JSON.stringify(info, null, 2)}\n`)
console.log(`Prepared GPL and ${dependencies.length} runtime package notices for ${info.version}${info.dirty ? ' (development changes)' : ''}`)
