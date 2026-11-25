'use client'

import { useEffect } from 'react'

/**
 * Ask the server to pull the wire once the page has painted.
 *
 * The server decides whether a refresh is actually due, so on most visits this
 * is a fast no-op. It exists because a page render cannot fetch a publisher
 * feed and the plan allows only one scheduled run a day, which left the front
 * page printing stale headlines.
 */
export default function WireTicker() {
  useEffect(() => {
    fetch('/api/wire/tick', { method: 'POST', cache: 'no-store', keepalive: true }).catch(() => {})
  }, [])

  return null
}
