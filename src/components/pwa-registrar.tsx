'use client'

import { useEffect, useState } from 'react'
import { Download, X, WifiOff, CheckCircle2, Smartphone } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function PwaRegistrar() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(false)
  const [isDismissed, setIsDismissed] = useState(false)
  const [isOffline, setIsOffline] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [showIOSGuide, setShowIOSGuide] = useState(false)

  useEffect(() => {
    // 1. Check if running standalone (already installed)
    if (typeof window !== 'undefined') {
      const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true
      if (isStandalone) {
        setIsInstalled(true)
      }

      // Check if user is on iOS Safari
      const ua = window.navigator.userAgent.toLowerCase()
      const isIosDevice = /iphone|ipad|ipod/.test(ua)
      const isSafari = ua.includes('safari') && !ua.includes('crios') && !ua.includes('fxios')
      if (isIosDevice && isSafari && !isStandalone) {
        setIsIOS(true)
      }

      // 2. Service Worker Lifecycle
      if ('serviceWorker' in navigator) {
        if (process.env.NODE_ENV === 'development') {
          // In development mode, purge all service workers and caches to prevent chunk conflicts
          navigator.serviceWorker.getRegistrations().then((registrations) => {
            registrations.forEach((r) => r.unregister().catch(() => {}))
          }).catch(() => {})
          if ('caches' in window) {
            caches.keys().then((keys) => {
              keys.forEach((key) => caches.delete(key).catch(() => {}))
            }).catch(() => {})
          }
        } else {
          // In production, register the lightweight asset service worker and purge old caches
          if ('caches' in window) {
            caches.keys().then((keys) => {
              keys.forEach((key) => {
                if (key !== 'najiki-cache-v5') {
                  caches.delete(key).catch((err) => console.warn('[PWA] Cache delete error:', err))
                }
              })
            }).catch((err) => console.warn('[PWA] Caches keys error:', err))
          }

          navigator.serviceWorker
            .register('/sw.js')
            .then((registration) => {
              registration.update().catch(() => {})
              console.log('[PWA] Service Worker registered with scope:', registration.scope)
            })
            .catch((err) => {
              console.warn('[PWA] Service Worker registration failed:', err)
            })
        }
      }

      // Automatically recover from dynamic chunk loading errors (e.g. after server rebuilds)
      const handleChunkError = (e: ErrorEvent) => {
        if (e?.message && /Loading chunk .* failed/i.test(e.message)) {
          const storageKey = 'last_chunk_reload'
          const lastReload = sessionStorage.getItem(storageKey)
          const now = Date.now()
          if (!lastReload || now - Number(lastReload) > 10000) {
            sessionStorage.getItem(storageKey)
            sessionStorage.setItem(storageKey, String(now))
            console.warn('[PWA] Recovering from chunk load error by unregistering SW and reloading...')
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
      }
      window.addEventListener('error', handleChunkError)

      // 3. Listen for Install Prompt (Chrome/Edge/Android)
      const handleBeforeInstallPrompt = (e: Event) => {
        e.preventDefault()
        setInstallPrompt(e as BeforeInstallPromptEvent)
      }

      const handleAppInstalled = () => {
        setIsInstalled(true)
        setInstallPrompt(null)
        console.log('[PWA] Application successfully installed')
      }

      // 4. Online/Offline Network Status
      const handleOnline = () => setIsOffline(false)
      const handleOffline = () => setIsOffline(true)

      setIsOffline(!navigator.onLine)

      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.addEventListener('appinstalled', handleAppInstalled)
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)

      // 5. Optional early tap-to-dismiss for the brand splash screen
      const splashEl = document.getElementById('najiki-splash-screen')
      const handleSplashDismiss = () => {
        if (splashEl) {
          splashEl.style.transition = 'opacity 0.35s ease, transform 0.35s ease'
          splashEl.style.opacity = '0'
          splashEl.style.pointerEvents = 'none'
          splashEl.style.transform = 'scale(1.04)'
          setTimeout(() => {
            if (splashEl) {
              splashEl.style.display = 'none'
            }
          }, 360)
        }
      }

      if (splashEl) {
        splashEl.addEventListener('click', handleSplashDismiss)
      }

      return () => {
        if (splashEl) {
          splashEl.removeEventListener('click', handleSplashDismiss)
        }
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
        window.removeEventListener('appinstalled', handleAppInstalled)
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('offline', handleOffline)
      }
    }
  }, [])

  const handleInstallClick = async () => {
    if (installPrompt) {
      await installPrompt.prompt()
      const choiceResult = await installPrompt.userChoice
      if (choiceResult.outcome === 'accepted') {
        setIsInstalled(true)
      }
      setInstallPrompt(null)
    } else if (isIOS) {
      setShowIOSGuide(true)
    }
  }

  return (
    <>
      {/* Offline Toast Indicator */}
      {isOffline && (
        <div
          id="pwa-offline-indicator"
          className="fixed bottom-4 left-4 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-medium backdrop-blur-md shadow-lg shadow-black/40 animate-fade-in"
        >
          <WifiOff className="w-4 h-4 text-amber-400 animate-pulse" />
          <span>Working offline • Cached data active</span>
        </div>
      )}

      {/* Floating PWA Install Prompt Banner (Only when installable and not yet dismissed) */}
      {!isInstalled && !isDismissed && (installPrompt || isIOS) && (
        <div
          id="pwa-install-banner"
          className="fixed bottom-4 right-4 z-50 max-w-sm w-[calc(100vw-2rem)] sm:w-auto p-4 rounded-2xl bg-zinc-900/95 border border-zinc-800/80 text-white backdrop-blur-xl shadow-2xl shadow-black/70 flex items-center gap-3.5 transition-all"
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shrink-0 shadow-md shadow-blue-600/30">
            <Smartphone className="w-5 h-5 text-white" />
          </div>

          <div className="flex-1 min-w-0 pr-1">
            <p className="text-xs font-semibold text-zinc-100 truncate">Install Na'jiki App</p>
            <p className="text-[11px] text-zinc-400 leading-tight">
              Fast, standalone access to your payment & messaging dashboard
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              id="pwa-install-btn"
              onClick={handleInstallClick}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-all shadow-md shadow-blue-500/25 active:scale-95 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Install
            </button>
            <button
              id="pwa-dismiss-btn"
              onClick={() => setIsDismissed(true)}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* iOS Installation Instruction Modal */}
      {showIOSGuide && (
        <div
          id="pwa-ios-modal"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4 text-zinc-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Install on iOS Safari</h3>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="p-1 text-zinc-400 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <ol className="text-sm text-zinc-300 space-y-3 list-decimal list-inside">
              <li>
                Tap the <span className="font-semibold text-white">Share</span> icon at the bottom of Safari.
              </li>
              <li>
                Scroll down and tap{' '}
                <span className="font-semibold text-white">"Add to Home Screen"</span>.
              </li>
              <li>
                Tap <span className="font-semibold text-white">"Add"</span> in the top right corner.
              </li>
            </ol>

            <button
              onClick={() => setShowIOSGuide(false)}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-all"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}
