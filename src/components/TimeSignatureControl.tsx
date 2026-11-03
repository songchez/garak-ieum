import { MAX_TIME_SIGNATURE_NUMERATOR, MIN_TIME_SIGNATURE_NUMERATOR, TIME_SIGNATURE_DENOMINATORS } from '../core/meter'
import type { TimeSignature, TimeSignatureDenominator } from '../core/types'

interface Props {
  value: TimeSignature
  disabled?: boolean
  onChange(numerator: number, denominator: TimeSignatureDenominator): void
}

const numerators = Array.from({ length: MAX_TIME_SIGNATURE_NUMERATOR - MIN_TIME_SIGNATURE_NUMERATOR + 1 }, (_, index) => index + MIN_TIME_SIGNATURE_NUMERATOR)

export function TimeSignatureControl({ value, disabled = false, onChange }: Props) {
  return <div className="time-signature" role="group" aria-label="박자표">
    <div className="signature-controls">
      <select value={value.numerator} disabled={disabled} aria-label="박자표 분자" title="한 마디의 박 수 · 1–32" onChange={event => onChange(Number(event.target.value), value.denominator)}>
        {numerators.map(numerator => <option key={numerator} value={numerator}>{numerator}</option>)}
      </select>
      <span aria-hidden="true">/</span>
      <select value={value.denominator} disabled={disabled} aria-label="박자표 분모" title="한 박의 음표 단위 · 2, 4, 8, 16" onChange={event => onChange(value.numerator, Number(event.target.value) as TimeSignatureDenominator)}>
        {TIME_SIGNATURE_DENOMINATORS.map(denominator => <option key={denominator} value={denominator}>{denominator}</option>)}
      </select>
    </div>
    <span>SIGNATURE</span>
  </div>
}
