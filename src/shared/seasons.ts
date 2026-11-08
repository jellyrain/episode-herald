import type { SeasonCard } from './types'

/** Some catalogue rows omit the season number or use zero for an unknown number. */
export function seasonNumber(season: SeasonCard): number | undefined {
  if (typeof season.index === 'number' && Number.isSafeInteger(season.index) && season.index > 0) return season.index
  const match = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*季(?=\s*(?:$|[!?:·(—-]))/u.exec(season.title.normalize('NFKC'))
  if (!match) return undefined
  const number = match[1]
  if (/^\d+$/.test(number)) return Number(number) || undefined
  const digits = '零一二三四五六七八九'
  if (number.length === 1 && number !== '十') return digits.indexOf(number)
  const tens = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(number)
  if (!tens) return undefined
  return (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0)
}

export function orderedSeasons(rows: SeasonCard[]): SeasonCard[] {
  return rows.map(row => ({ ...row, index: seasonNumber(row) }))
    .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
}

/** Match a missing, previously unpublished row only to an unambiguous released season. */
export function releasedSeasonFor(reservation: SeasonCard, directory: SeasonCard[]): SeasonCard | undefined {
  const index = seasonNumber(reservation)
  if (!index || (reservation.episodeCount ?? 0) > 0) return undefined
  const matches = directory.filter(row => seasonNumber(row) === index)
  if (matches.length === 1 && (matches[0].episodeCount ?? 0) > 0) return matches[0]
  return undefined
}
