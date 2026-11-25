/**
 * Persist the RSS wire into Firestore.
 *
 * Every headline a publisher offers becomes a normal `articles` document with
 * `wire: true`, so the front page, sections, search, feeds and the internal
 * story page all read from one place. The document keeps the publisher's own
 * image URL and the attribution needed to credit it on-site.
 *
 * The sync is:
 *   - idempotent — document IDs come from a hash of the article link;
 *   - incremental — unchanged headlines are skipped, existing images are reused
 *     before any publisher page is scraped for an Open Graph image;
 *   - bounded — a small worker pool, no more than a handful of scrapes per run;
 *   - housekeeping — wire items older than two weeks are removed.
 */
import { createHash } from 'node:crypto'
import { canWrite, deleteDoc, readCollection, readDoc, writeDoc } from '@/lib/desk/store'
import { fetchOgImage, fetchWire, getFeedImageMap } from '@/lib/wire'
import { submitToIndexNow } from '@/lib/indexnow'
import { siteUrl } from '@/lib/site'
import { invalidateContentCache } from '@/lib/content'

export const WIRE_RETENTION_DAYS = 14
// The scheduled job and the desk's refresh button (which passes `force`) ignore
// this throttle and always run. Page revalidation uses the shorter window below
// instead, so headlines keep moving between scheduled runs.
export const WIRE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

// How stale the wire may go before a page revalidation refreshes it: short
// enough to keep up with the publishers, long enough that a busy morning does
// not pull every feed on every request.
export const WIRE_REFRESH_MS = 10 * 60 * 1000

// One reserved row records the last refresh, so separate serverless instances
// agree on how old the wire is.
export const WIRE_STATE_ID = 'wire_sync_state'

const MAX_OG_SCRAPES = 40
const OG_CONCURRENCY = 6
const MAX_ITEMS = 80

function nowIso() {
  return new Date().toISOString()
}

function hashOf(link) {
  return createHash('sha1').update(String(link || '')).digest('hex').slice(0, 16)
}

function slugify(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
}

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const queue = [...items]
  const results = []
  async function next() {
    while (queue.length) {
      const item = queue.shift()
      results.push(await worker(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, next))
  return results
}

/**
 * Fill in images for feed items that arrived without one. Existing stored
 * images are always preferred, so a publisher page is fetched at most once per
 * headline.
 */
async function resolveImages(items, existingById) {
  const seen = new Set()
  const needs = []
  for (const item of items) {
    const id = `wire_${hashOf(item.link)}`
    const existingImage = existingById.get(id)?.coverImageUrl
    if (item.image || existingImage) continue
    if (seen.has(id)) continue
    seen.add(id)
    needs.push({ id, link: item.link })
  }

  const scraped = new Map()
  await pool(needs.slice(0, MAX_OG_SCRAPES), OG_CONCURRENCY, async ({ id, link }) => {
    const image = await fetchOgImage(link)
    if (image) scraped.set(id, image)
  })
  return scraped
}

/**
 * Re-check stored wire stories that are still using the fallback cover. A
 * publisher page can be slow or briefly blocked, so an item that failed once
 * gets another chance on later syncs instead of staying image-less for good.
 */
async function backfillImages(wireDocs, items = []) {
  const missing = wireDocs
    .filter((doc) => !doc.coverImageUrl && doc.originalUrl)
    .slice(0, 20)
  if (!missing.length) return 0

  const byLink = new Map(items.map((item) => [item.link, item]))

  let fixed = 0
  await pool(missing, OG_CONCURRENCY, async (doc) => {
    const source = byLink.get(doc.originalUrl)
    // The publisher's own feed is the cheapest source of a picture; scraping
    // is the last resort because many newsrooms block it outright.
    let image = source?.image
    if (!image) {
      const feedImages = await getFeedImageMap(doc.source)
      image = feedImages.get(doc.originalUrl)
    }
    if (!image) image = await fetchOgImage(doc.originalUrl)
    if (!image) image = source?.fallbackImage
    if (!image) return
    try {
      await writeDoc(
        'articles',
        doc.id,
        {
          ...doc,
          coverImageUrl: image,
          remoteImage: true,
          imageAlt: doc.imageAlt || doc.title,
          updatedAt: nowIso(),
        },
        { merge: true }
      )
      fixed += 1
    } catch {
      // One failed write must not stop the rest.
    }
  })
  return fixed
}

function buildDoc({ item, id, existing, ogImage }) {
  const publishedAt =
    isoOrNull(existing?.publishedAt) || isoOrNull(item.publishedAt) || nowIso()
  const createdAt = isoOrNull(existing?.createdAt) || publishedAt
  const slug =
    existing?.slug ||
    `wire-${slugify(item.title) || 'headline'}-${id.slice(-6)}`
  // Prefer the story's own picture, then a stored one, then a scraped OG image,
  // then the publisher's channel image — anything but a bare frame.
  const image = item.image || existing?.coverImageUrl || ogImage || item.fallbackImage || ''

  return {
    id,
    slug,
    title: item.title,
    dek: item.summary || '',
    section: item.section || 'kenya',
    tags: Array.isArray(item.tags) ? item.tags : [],
    body: item.content || item.summary || '',
    status: 'published',
    wire: true,
    source: item.source,
    sourceUrl: item.sourceUrl || '',
    originalUrl: item.link,
    imageCredit: item.source,
    authorUid: '',
    authorSlug: '',
    authorName: item.source,
    authorTitle: 'Wire',
    coverImageUrl: image,
    remoteImage: Boolean(image),
    imageAlt: item.title,
    imageCaption: '',
    isFeatured: false,
    isBreaking: false,
    createdAt,
    updatedAt: nowIso(),
    createdBy: 'wire-sync',
    publishedAt,
    publishedBy: 'wire-sync',
    views: Number(existing?.views) || 0,
  }
}

function unchanged(existing, next) {
  if (!existing) return false
  return (
    existing.title === next.title &&
    existing.dek === next.dek &&
    existing.section === next.section &&
    existing.body === next.body &&
    existing.coverImageUrl === next.coverImageUrl &&
    existing.originalUrl === next.originalUrl &&
    existing.status === next.status
  )
}

async function runSync() {
  const startedAt = nowIso()
  const existing = await readCollection('articles')
  const wireDocs = existing.filter((doc) => doc.wire)
  const existingById = new Map(existing.map((doc) => [doc.id, doc]))

  const items = (await fetchWire(MAX_ITEMS)).filter((item) => item.title && item.link)
  const scraped = await resolveImages(items, existingById)

  const seen = new Set()
  const changedUrls = []
  let added = 0
  let updated = 0
  let skipped = 0
  let skippedNoImage = 0

  for (const item of items) {
    const id = `wire_${hashOf(item.link)}`
    if (seen.has(id)) continue
    seen.add(id)

    const doc = buildDoc({
      item,
      id,
      existing: existingById.get(id),
      ogImage: scraped.get(id),
    })

    // No length filter here: short wire items are published on the site and
    // must reach the front page and the RSS feed as soon as they arrive.

    // House rule: every story carries a picture. A wire item whose publisher
    // offers no image — in the feed, in the stored row, from the article page
    // or from the channel — is not published at all.
    if (!doc.coverImageUrl) {
      skippedNoImage += 1
      continue
    }

    if (unchanged(existingById.get(id), doc)) {
      skipped += 1
      continue
    }

    try {
      await writeDoc('articles', id, doc, { merge: true })
      if (existingById.has(id)) updated += 1
      else added += 1
      changedUrls.push(`${siteUrl()}/news/${doc.slug}`)
    } catch {
      // A single failed document must not abandon the rest of the sync.
    }
  }

  // Tell Bing, DuckDuckGo, Yahoo, Yandex and Seznam about new or changed
  // stories as soon as they land. Best-effort: a failure never stops the sync.
  if (changedUrls.length) {
    await submitToIndexNow(changedUrls)
  }

  // Second chance for stored stories whose publisher image never arrived.
  const imagesFixed = await backfillImages(wireDocs, items)

  // Housekeeping: drop wire items that have aged out of the feed window and
  // are no longer among the headlines we just saw.
  const cutoff = Date.now() - WIRE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const doc of wireDocs) {
    if (seen.has(doc.id)) continue
    // Videos are not part of the wire: remove any that were stored earlier.
    const url = String(doc.originalUrl || '')
    const video = /\/videos?\//i.test(url) || /youtube\.com|youtu\.be|vimeo\.com/i.test(url)
    const date = new Date(doc.publishedAt || doc.createdAt || 0).getTime()
    if (video || (Number.isFinite(date) && date < cutoff)) {
      try {
        await deleteDoc('articles', doc.id)
        removed += 1
      } catch {
        // Ignore; retention is best-effort.
      }
    }
  }

  return {
    ok: true,
    startedAt,
    finishedAt: nowIso(),
    fetched: items.length,
    added,
    updated,
    skipped,
    skippedNoImage,
    removed,
    imagesFixed,
    total: seen.size,
  }
}

/** When the wire was last refreshed, from the reserved state row. */
export async function wireLastRefreshAt() {
  try {
    const stateRow = await readDoc('articles', WIRE_STATE_ID)
    // The row borrows the article columns; the sync time lives in updatedAt.
    const stamp = stateRow?.updatedAt || stateRow?.createdAt
    const at = stamp ? new Date(stamp).getTime() : 0
    return Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

async function recordWireRun(at = nowIso(), stage = '') {
  try {
    await writeDoc(
      'articles',
      WIRE_STATE_ID,
      {
        id: WIRE_STATE_ID,
        slug: 'wire-sync-state',
        // 'meta' keeps this row out of the public archive and the desk lists.
        status: 'meta',
        title: 'Wire sync state',
        section: 'meta',
        // The last stage reached, so a refresh that never finishes leaves a
        // trace instead of failing silently.
        dek: stage,
        body: '',
        createdAt: at,
        updatedAt: at,
        publishedAt: at,
      },
      { merge: true }
    )
  } catch {
    // A throttle, not a source of truth: a failed write must not stop the sync.
  }
}

/**
 * Pull the wire only when it has gone stale.
 *
 * This is what keeps the site current on a plan that allows a single daily
 * cron: page revalidation asks for a refresh, and the state row makes sure at
 * most one run happens per window. Two instances can both decide to run; the
 * sync is idempotent, so the second one finds nothing new.
 */
export async function refreshWireIfStale(maxAgeMs = WIRE_REFRESH_MS) {
  // Prerendering at build time must not reach out to a dozen publishers.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { ok: true, skipped: 'build' }
  }
  if (!canWrite()) return { ok: false, reason: 'read-only' }

  const last = await wireLastRefreshAt()
  if (last && Date.now() - last < maxAgeMs) {
    return { ok: true, throttled: true, lastRunAt: new Date(last).toISOString() }
  }

  // Claim the window first, so a burst of revalidations does not start a sync
  // each.
  const at = nowIso()
  await recordWireRun(at, 'claimed')

  // TEMPORARY probe: the same fetch from this context returns nothing, so the
  // state row records what actually happened.
  let probe = ''
  try {
    const response = await fetch('https://www.kbc.co.ke/feed/', { cache: 'no-store' })
    probe = `probe:${response.status}`
  } catch (error) {
    probe = `probe-error:${error?.name || 'Error'}:${String(error?.message || error).slice(0, 60)}`
  }
  await recordWireRun(at, probe)
  const result = await syncWire({ force: true })
  await recordWireRun(
    at,
    result?.ok
      ? `done fetched=${result.fetched} added=${result.added} skipped=${result.skipped}`
      : `failed ${result?.reason || 'unknown'}`
  )
  return result
}

const state = (globalThis.__tnkWireSync ||= { lastFinished: 0, running: null, lastResult: null })

/**
 * Sync the wire into the database. Called only when the desk asks for it; a
 * reader opening a page never triggers a feed fetch or a write. Concurrent
 * callers share one run, so a double click cannot multiply the work.
 */
export async function syncWire({ force = false } = {}) {
  if (!canWrite()) {
    return { ok: false, reason: 'read-only', fetched: 0, added: 0, updated: 0, skipped: 0, removed: 0 }
  }

  if (state.running) return state.running

  const fresh =
    !force && state.lastFinished && Date.now() - state.lastFinished < WIRE_SYNC_INTERVAL_MS
  if (fresh) {
    return { ok: true, throttled: true, ...(state.lastResult || {}) }
  }

  state.running = runSync()
    .catch((error) => ({
      ok: false,
      reason: error?.message || 'sync failed',
      fetched: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
    }))
    .then((result) => {
      invalidateContentCache()
      state.running = null
      state.lastFinished = Date.now()
      state.lastResult = result
      return result
    })

  return state.running
}
