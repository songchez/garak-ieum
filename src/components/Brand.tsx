import { BRAND } from '../brand'
import './Brand.css'

export function Brand({ size = 'compact' }: { size?: 'compact' | 'large' }) {
  const markSize = size === 'large' ? 76 : 20
  return (
    <span className={`brand-lockup brand-lockup--${size}`}>
      <img className="brand-logo" src={BRAND.mark} alt="" width={markSize} height={markSize} decoding="async" />
      <span className="brand-wordmark" role="img" aria-label={BRAND.name}
        style={{ maskImage: `url(${BRAND.wordmark})`, WebkitMaskImage: `url(${BRAND.wordmark})` }} />
    </span>
  )
}
