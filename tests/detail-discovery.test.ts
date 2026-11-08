import assert from 'node:assert/strict'
import test from 'node:test'
import type { Client, Series } from 'openhongguo'
import type { OriginalNovel } from '../src/shared/types'
import { Provider } from '../src/main/provider'

const root: Series = {
  id: '10001', title: '作品甲', season_index: 1, episode_count: 112, heat: 43680000,
  category: '爱情', rows: [{ kind: 40, text: '都市爱情·重生' }, { kind: 33, text: '演员示例' }]
}
const album = {
  id: '90000', season_count: 3, seasons: [
    { series_id: root.id, index: 1, title: root.title, episode_count: 112 },
    { series_id: '10002', index: 2, title: '作品甲第二季', episode_count: 125 },
    { series_id: '10003', index: 3, title: '作品甲第三季' }
  ]
}
function provider(overrides: Partial<Client> = {}): Provider {
  const client = {
    getSeries: async () => root,
    seasons: async () => album,
    shortFilterPanel: async () => [],
    seriesRecommend: async () => ({ items: [] }),
    ...overrides
  } satisfies Partial<Client>
  return new Provider('', Promise.resolve(client as Client))
}
const panel = [{ key: 'category_dim_theme', name: '题材', options: [
  { name: '都市爱情', value: 'city' }, { name: '爱情', value: 'love' }, { name: '重生', value: 'rebirth' }
] }]

test('search detail covers match the requested IDs even when the SDK returns them out of order or omits one', async () => {
  const api = provider({ getSeriesBatch: async ids => {
    assert.deepEqual(ids,['10001','10002','10003'])
    return [
      { series: { ...root,id:'10003',cover_url:'//p3.byteimg.com/three.heic' },episodes:[] },
      { series: { ...root,id:'10004',cover_url:'https://p3.byteimg.com/other' },episodes:[] },
      { series: { ...root,id:'10001',cover_url:'http://p3.byteimg.com/one.heic' },episodes:[] }
    ]
  } })
  assert.deepEqual(await api.searchCovers(['10001','10002','10001','10003']),{
    '10001':'https://p3.byteimg.com/one.heic','10003':'https://p3.byteimg.com/three.heic'
  })
  await assert.rejects(api.searchCovers(['bad']), /编号/)
})

test('routine season lookup takes published counts from one SDK album call and leaves a reservation count unknown', async () => {
  const calls: string[] = []
  const api = provider({
    seasons: async id => { calls.push(id); return album },
    getSeries: async () => assert.fail('unexpected season detail request'),
    listEpisodes: async () => assert.fail('unexpected episode request')
  })
  const directory = await api.seasonDirectory(root.id)
  assert.deepEqual(calls, [root.id])
  assert.equal(directory.expectedCount, 3)
  assert.deepEqual(directory.seasons.map(row => [row.id, row.episodeCount]), [
    [root.id, 112], ['10002', 125], ['10003', undefined]
  ])
})

test('details sort an unnumbered 第五季 after season four, including when that season is selected', async () => {
  const rows = [
    { series_id: '70005', title: '重生之绝世仙帝第五季', index: 0, episode_count: 131 },
    ...[1, 2, 3, 4].map(index => ({ series_id: String(70000 + index), title: '重生之绝世仙帝', index, episode_count: 113 }))
  ]
  const api = provider({
    seasons: async () => ({ id: '79000', season_count: 5, seasons: rows }),
    getSeries: async id => {
      const row = rows.find(season => season.series_id === id)!
      return { id, title: row.title, episode_count: row.episode_count }
    }
  })
  for (const id of ['70001', '70005']) {
    const { seasons } = await api.details(id)
    assert.deepEqual(seasons.map(row => row.index), [1, 2, 3, 4, 5])
    assert.deepEqual([seasons[4].id, seasons[4].episodeCount], ['70005', 131])
  }
})

test('a later album tag reorders an unnumbered title and overrides an outdated number in its own details', async () => {
  const rows = [
    { series_id: '70006', title: '仙途终章', index: 6 },
    { series_id: '70005', title: '归来篇', index: 0 },
    { series_id: '70001', title: '仙途', index: 1 }
  ]
  const api = provider({
    seasons: async () => ({ id: '79000', season_count: 3, seasons: rows }),
    getSeries: async id => ({ id, title: rows.find(row => row.series_id === id)!.title, season_index: id === '70005' ? 6 : 1 })
  })
  const before = await api.details('70001')
  assert.deepEqual(before.seasons.map(row => row.index), [1, 6, undefined])
  rows[1].index = 5
  for (const selected of ['70001', '70005']) {
    const after = await api.details(selected)
    assert.equal(after.directoryComplete, true)
    assert.deepEqual(after.seasons.map(row => row.index), [1, 5, 6])
    assert.equal(after.seasons[1].title, '归来篇')
  }
})

test('original novel metadata comes from the existing series request, including when the album fails', async () => {
  const calls: string[] = []
  const api = provider({
    getSeries: async id => {
      calls.push(id)
      return { ...root, novel: { book_id: '90001', title: '原著书名', short_title: '剧名', tags: ['重生', '重生', ' '],
        status: 0, cover_url: 'https://example.com/book.jpg', reads: 0, show_at_episode: 12 } }
    },
    seasons: async () => { throw Error('album unavailable') },
    seriesRecommend: async () => assert.fail('recommendations requested before expanding')
  })
  const details = await api.details(root.id)
  assert.deepEqual(calls, [root.id])
  assert.deepEqual(details.originalNovel, {
    bookId: '90001', title: '原著书名', shortTitle: '剧名', coverUrl: 'https://example.com/book.jpg', tags: ['重生'], statusLabel: '已完结', reads: 0, showAtEpisode: 12
  })
})

test('distinguish a linked book with no title from missing original novel information', async () => {
  const metadata = async (extra: Partial<Series>): Promise<OriginalNovel | undefined> =>
    (await provider({ getSeries: async () => ({ ...root, ...extra }) }).details(root.id)).originalNovel
  assert.equal(await metadata({}), undefined)
  assert.equal(await metadata({ related_novel_book_id: '0' }), undefined)
  const idOnly = await metadata({ related_novel_book_id: '90002' })
  assert.equal(idOnly?.bookId, '90002')
  assert.equal(idOnly?.title, undefined)
  const partial = await metadata({ related_novel_book_id: '90002', novel: {
    book_id: '0', title: '', short_title: '书籍短标题', status: -1, cover_url: 'javascript:invalid'
  } })
  assert.equal(partial?.title, '书籍短标题')
  assert.equal(partial?.bookId, '90002')
  assert.equal(partial?.statusLabel, undefined)
  assert.equal(partial?.coverUrl, undefined)
  const partialCounts = await metadata({ novel: { book_id: '', title: '', status: -1, reads: 0, show_at_episode: 0 } })
  assert.equal(partialCounts?.reads, 0)
  assert.equal(partialCounts?.showAtEpisode, undefined)
  assert.equal(await metadata({ novel: { book_id: '', title: '', status: -1, reads: -1 } }), undefined)
})

test('heat belongs to its own season, including zero, and album loading never probes unreleased seasons', async () => {
  const calls: string[] = []
  const api = provider({ getSeries: async id => {
    calls.push(id)
    if (id === '10002') return { id, title: '第二季', heat: 0 }
    if (id === '10003') throw Object.assign(new Error(), { code: 'ANONYMOUS_LIMITED' })
    return root
  } })
  const details = await api.details(root.id)
  assert.deepEqual(calls, [root.id])
  assert.deepEqual(details.seasons.map(s => s.heat), [43680000, undefined, undefined])
  assert.deepEqual(details.seasons.map(s => s.episodeCount), [112, 125, undefined])
  assert.equal(await api.seasonHeat(root.id), 43680000)
  assert.equal(await api.seasonHeat('10002'), 0)
  assert.equal(await api.seasonHeat('10003'), null)
  assert.equal(await api.seasonHeat('10003'), null)
  assert.deepEqual(calls, ['10001', '10002', '10003'])
  assert.equal((await api.details(root.id)).seasons[1].heat, 0)
})

test('missing heat stays unknown, transport failures can be retried, and mismatched IDs never supply heat', async () => {
  let attempt = 0
  const api = provider({ getSeries: async id => {
    if (id === '20001') return { id, title: '预告', follow_count: 265000 }
    if (id === '20002') return root
    if (++attempt === 1) throw new Error('offline')
    return { id, title: '已播', heat: 12345 }
  } })
  assert.equal(await api.seasonHeat('20001'), null)
  await assert.rejects(api.seasonHeat('20002'), /不一致/)
  await assert.rejects(api.seasonHeat('20003'), /offline/)
  assert.equal(await api.seasonHeat('20003'), 12345)
})

test('rank by shared subjects, cap at four, skip other seasons and deduplicate across filter pages', async () => {
  const filters: string[][] = []
  const api = provider({
    shortFilterPanel: async () => panel,
    shortFilter: async query => {
      const selections = query!.selections!
      assert.deepEqual(selections.genre, ['short_play'])
      filters.push(selections.category_dim_theme)
      const ids = selections.category_dim_theme[0] === 'city'
        ? ['10002', root.id, '30001', '30002', '30003', '30004', '30005']
        : ['10003', '30002']
      return { items: ids.map(id => ({ id, title: id })), has_more: false }
    },
    seriesRecommend: async () => { throw Error('unexpected generic feed') }
  })
  const matches = await api.similarSeries(root.id)
  assert.deepEqual(filters, [['city'], ['rebirth']])
  assert.deepEqual(matches.map(m => m.series.id), ['30002', '30001', '30003', '30004'])
  assert.deepEqual(matches[0].matchedTags, ['都市爱情', '重生'])
})

test('a failed facet does not hide matches from the other facet', async () => {
  const api = provider({
    shortFilterPanel: async () => panel,
    shortFilter: async query => {
      if (query!.selections!.category_dim_theme[0] === 'city') throw Error('unavailable')
      return { items: [{ id: '30001', title: '乙' }], has_more: false }
    }
  })
  assert.deepEqual((await api.similarSeries(root.id)).map(m => m.matchedTags), [['重生']])
})

test('the generic recommendation feed needs an independent matching tag', async () => {
  const api = provider({
    shortFilterPanel: async () => { throw Error('filter unavailable') },
    seriesRecommend: async () => ({ items: [
      { id: '10002', title: '同系列', category: '重生' }, { id: '30001', title: '无标签' },
      { id: '30002', title: '其他题材', category: '奇幻' }, { id: '30003', title: '同题材', category: '重生' }
    ] })
  })
  assert.deepEqual((await api.similarSeries(root.id)).map(m => m.series.id), ['30003'])
  assert.deepEqual(await provider().similarSeries(root.id), [])
  await assert.rejects(provider({ shortFilterPanel: async () => { throw Error('offline') } }).similarSeries(root.id), /offline/)
})
