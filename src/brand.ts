import { version } from '../package.json'

export const BRAND = {
  name: '가락이음',
  englishName: 'Garak Ieum',
  /** Follows package.json, which release:prepare bumps. */
  version,
  mark: '/brand/garak-ieum-mark.png',
  wordmark: '/brand/garak-ieum-wordmark.svg',
  fontName: '덕온공주체',
  fontSource: 'https://hanfont.hangeul.go.kr/relaxfont/font/deokon.do',
  fontLicense: '/fonts/DeogonPrincess-LICENSE.txt',
} as const

export const SOURCE_REPOSITORY_URL = 'https://github.com/songchez/garak-ieum'
