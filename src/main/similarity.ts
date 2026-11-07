import type { FilterRow, SeriesCard, SeriesDetails, SimilarSeries } from '../shared/types'

const genericTags = new Set(['全部', '短剧', '影视剧', '真人', '真人剧', '真人短剧', '漫剧', '动态漫', 'AI', 'AI剧', 'AI漫剧', '男频', '女频', '完结', '连载', '已完结'])

export function themes(tags: string[]): string[] {
  const parts = tags.flatMap(tag => tag.split(/[、,，;；|｜·/\s]+/u))
  return [...new Set(parts.filter(tag => tag.length >= 2 && !genericTags.has(tag)))]
}

interface SubjectFilter {
  tag: string
  key: string
  value: string
}

export function matchingFacets(tags: string[], rows: FilterRow[]): SubjectFilter[] {
  const matches: SubjectFilter[] = []
  for (const tag of [...tags].sort((a, b) => b.length - a.length)) {
    if (matches.some(match => match.tag.includes(tag))) continue
    for (const row of rows) {
      if (/genre|sort|status|length|price|time/i.test(row.key)) continue
      const option = row.options.find(option => option.name.trim() === tag && option.value)
      if (option) {
        matches.push({ tag, key: row.key, value: option.value })
        break
      }
    }
    if (matches.length === 2) break
  }
  return matches
}

export function similarMatches(details: SeriesDetails, groups: { items: SeriesCard[]; tag?: string }[]): SimilarSeries[] {
  const excluded = new Set([details.series.id, ...details.seasons.map(s => s.id)])
  const tags = themes(details.series.tags)
  const candidates = new Map<string, SimilarSeries>()
  for (const { items, tag } of groups) {
    for (const series of items) {
      if (excluded.has(series.id)) continue
      const ownTags = themes(series.tags)
      const evidence = tags.filter(t => t === tag || ownTags.includes(t))
      if (!evidence.length) continue
      const previous = candidates.get(series.id)
      candidates.set(series.id, { series, matchedTags: [...new Set([...(previous?.matchedTags ?? []), ...evidence])] })
    }
  }
  return [...candidates.values()].sort((a, b) => b.matchedTags.length - a.matchedTags.length).slice(0, 4)
}
