'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Avoid just logging {"isTrusted":true} which isn't helpful
    if (error && typeof error === 'object' && 'isTrusted' in error) {
      console.error('[Global Error Boundary] Caught Event:', (error as any).type || 'Unknown DOM Event', error)
    } else {
      console.error('[Global Error Boundary]', error)
    }
    
    // Automatically recover from Next.js chunk loading failures
    const errorMsg = error?.message || String(error)
    if (/Loading chunk .* failed/i.test(errorMsg)) {
      const storageKey = 'last_chunk_reload'
      const lastReload = sessionStorage.getItem(storageKey)
      const now = Date.now()
      if (!lastReload || now - Number(lastReload) > 10000) {
        sessionStorage.setItem(storageKey, String(now))
        console.warn('Recovering from chunk load error by unregistering SW and reloading...')
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then((registrations) => {
            registrations.forEach((r) => {
              r.unregister().catch(console.error)
            })
          }).catch(console.error)
        }
        setTimeout(() => {
          window.location.reload()
        }, 500)
      }
    }
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-4 text-center">
      <h2 className="text-2xl font-bold mb-4">Something went wrong!</h2>
      <p className="text-muted-foreground mb-6 max-w-md">
        An unexpected error occurred while loading this page.
      </p>
      <button
        onClick={() => {
          // If it's a chunk error, force a hard reload
          const errorMsg = error?.message || String(error)
          if (/Loading chunk .* failed/i.test(errorMsg)) {
            window.location.reload()
          } else {
            reset()
          }
        }}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  )
}
