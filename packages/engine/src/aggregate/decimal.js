import { decimal } from '../obs/index.js'

/** Fixed-point arithmetic for decimal wire prices. Weights and screen values can be doubles. */
function fixed(value) {
  const text =
    typeof value === 'string' && value.length <= 512 && /^\d+(?:\.\d+)?$/.test(value) ? value : decimal(value)
  if (text == null) return null
  const [whole, fraction = ''] = text.split('.')
  return { coefficient: BigInt(whole + fraction), scale: fraction.length }
}

function render(coefficient, scale) {
  const digits = coefficient.toString().padStart(scale + 1, '0')
  if (!scale) return digits
  return (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/0+$/, '').replace(/\.$/, '')
}

export function multiplyPrice(left, right) {
  const a = fixed(left),
    b = fixed(right)
  return a && b ? render(a.coefficient * b.coefficient, a.scale + b.scale) : null
}

function compare(a, b) {
  const scale = Math.max(a.scale, b.scale)
  const delta = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}

export function medianPrice(entries) {
  const items = entries
    .filter((e) => e.weight > 0 && Number.isFinite(e.weight))
    .map((e) => ({ amount: fixed(e.value), weight: e.weight }))
    .filter((e) => e.amount)
    .sort((a, b) => compare(a.amount, b.amount))
  if (!items.length) return null
  const half = items.reduce((total, item) => total + item.weight, 0) / 2
  let weight = 0
  for (const [index, item] of items.entries()) {
    weight += item.weight
    const a = item.amount
    if (weight === half && items[index + 1]) {
      const b = items[index + 1].amount,
        scale = Math.max(a.scale, b.scale)
      const sum = a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale)
      return render(sum * 5n, scale + 1)
    }
    if (weight >= half) return render(a.coefficient, a.scale)
  }
}
