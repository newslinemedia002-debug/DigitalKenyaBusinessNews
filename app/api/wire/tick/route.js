import { NextResponse } from 'next/server'
import { refreshWireIfStale } from '@/lib/wire-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The nudge from a reader's browser that keeps the wire current.
 *
 * A Hobby plan allows one cron run a day, which is not enough for a wire that
 * moves all morning, and a page render cannot fetch a publisher feed at all.
 * So a request handler does the work: it pulls the feeds only when the state
 * row says the last refresh is older than the window, which keeps a busy
 * morning to a handful of runs an hour rather than one per visit.
 *
 * Same-origin only, no parameters, and nothing secret is exposed: the route
 * pulls the feeds this site already reads and writes through the server's own
 * database credentials.
 */
export async function POST(request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (originHost !== host) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
  }

  const result = await refreshWireIfStale()
  return NextResponse.json(result, { status: result.ok === false ? 500 : 200 })
}
