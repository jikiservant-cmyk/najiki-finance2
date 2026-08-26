'use client'

import { WifiOff, RefreshCw, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function OfflinePage() {
  return (
    <div id="offline-container" className="min-h-screen bg-[#09090b] text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none -top-20 -left-20" />
      <div className="absolute w-96 h-96 bg-emerald-600/10 rounded-full blur-3xl pointer-events-none -bottom-20 -right-20" />

      <div className="max-w-md w-full text-center z-10 space-y-6">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-zinc-900/90 border border-zinc-800 flex items-center justify-center shadow-xl shadow-black/50">
          <WifiOff className="w-10 h-10 text-amber-400 animate-pulse" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">
            You're currently offline
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Na'jiki PWA couldn't reach the network. Cached pages and views are still available, but real-time payments and messaging require an active internet connection.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <button
            id="offline-retry-btn"
            onClick={() => window.location.reload()}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-all shadow-lg shadow-blue-500/20 active:scale-95"
          >
            <RefreshCw className="w-4 h-4" />
            Retry Connection
          </button>
          
          <Link
            id="offline-home-link"
            href="/"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-sm font-medium transition-all active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
        </div>

        <div className="pt-6 border-t border-zinc-900 text-xs text-zinc-500">
          Na'jiki Tech PWA • Offline Mode
        </div>
      </div>
    </div>
  )
}
