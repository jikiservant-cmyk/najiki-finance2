'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'

// Deterministic positions for scattered mini-symbols
const DOT_CONFIGS = [
  { top: 12, left: 8, yRange: 22, duration: 7, delay: 0 },
  { top: 25, left: 45, yRange: 18, duration: 9, delay: 1 },
  { top: 38, left: 78, yRange: 25, duration: 6, delay: 2 },
  { top: 55, left: 15, yRange: 20, duration: 11, delay: 3 },
  { top: 68, left: 62, yRange: 15, duration: 8, delay: 0.5 },
  { top: 80, left: 30, yRange: 28, duration: 10, delay: 1.5 },
  { top: 15, left: 90, yRange: 20, duration: 7.5, delay: 2.5 },
  { top: 45, left: 55, yRange: 22, duration: 9.5, delay: 4 },
  { top: 72, left: 85, yRange: 18, duration: 6.5, delay: 3.5 },
  { top: 30, left: 22, yRange: 25, duration: 8.5, delay: 1 },
  { top: 60, left: 40, yRange: 20, duration: 7, delay: 2 },
  { top: 88, left: 70, yRange: 15, duration: 10.5, delay: 0.8 },
]

// Science/code/math symbols
const SYMBOLS = [
  'π', '∫', '∑', '∂', '∞', '∇', 'λ', 'Δ',
  '{ }', '</>', '01', 'fn', '=>', '//',
  'DNA', 'ATCG', 'Ω', 'α',
]

// Main floating symbols — position, symbol, size
const MAIN_SYMBOLS = [
  { symbol: 'π', top: '8%', right: '6%', size: '3.5rem' },
  { symbol: '∫', top: '30%', left: '4%', size: '4rem' },
  { symbol: '{ }', bottom: '12%', right: '10%', size: '2.2rem' },
  { symbol: 'DNA', top: '18%', left: '25%', size: '1.6rem' },
  { symbol: '∑', top: '55%', right: '8%', size: '3rem' },
  { symbol: '∇', top: '42%', left: '50%', size: '2.8rem' },
  { symbol: '</>', bottom: '25%', left: '12%', size: '2rem' },
  { symbol: 'λ', top: '72%', left: '65%', size: '2.8rem' },
  { symbol: '∞', top: '5%', left: '55%', size: '2.4rem' },
  { symbol: 'ATCG', bottom: '35%', right: '25%', size: '1.2rem' },
]

export function FloatingGeometry() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {/* Main floating symbols */}
      {MAIN_SYMBOLS.map((s, i) => {
        const posStyle: React.CSSProperties = { position: 'absolute', fontSize: s.size }
        if (s.top) posStyle.top = s.top
        if (s.bottom) posStyle.bottom = s.bottom
        if (s.left) posStyle.left = s.left
        if (s.right) posStyle.right = s.right

        return (
          <motion.div
            key={i}
            className="flex items-center justify-center text-primary/40 font-light select-none"
            style={posStyle}
            animate={{
              y: [-12, 12, -12],
              rotate: [-5, 5, -5],
            }}
            transition={{
              y: { duration: 8 + i * 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.7 },
              rotate: { duration: 12 + i * 2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.5 },
            }}
          >
            {s.symbol === '</>' ? <>&lt;/&gt;</> : s.symbol}
          </motion.div>
        )
      })}

      {/* Scattered mini-symbols */}
      {mounted && DOT_CONFIGS.map((cfg, i) => (
        <motion.div
          key={i}
          className="absolute flex items-center justify-center font-mono text-primary/30 select-none"
          style={{
            top: `${cfg.top}%`,
            left: `${cfg.left}%`,
            fontSize: '0.85rem',
          }}
          animate={{
            y: [0, -cfg.yRange, 0],
            opacity: [0.2, 0.45, 0.2],
          }}
          transition={{
            duration: cfg.duration,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: cfg.delay,
          }}
        >
          {SYMBOLS[i % SYMBOLS.length]}
        </motion.div>
      ))}
    </div>
  )
}
