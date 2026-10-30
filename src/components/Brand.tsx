import { BRAND } from '../brand'
import './Brand.css'

export function Brand({ size = 'compact' }: { size?: 'compact' | 'large' }) {
  const markSize = size === 'large' ? 76 : 36
  return (
    <span className={`brand-lockup brand-lockup--${size}`}>
      <img className="brand-logo" src={BRAND.mark} alt="" width={markSize} height={markSize} decoding="async" />
      <img className="brand-wordmark" src={BRAND.wordmark} alt={BRAND.name} width={size === 'large' ? 193 : 110} height={size === 'large' ? 60 : 34} decoding="async" />
    </span>
  )
}
