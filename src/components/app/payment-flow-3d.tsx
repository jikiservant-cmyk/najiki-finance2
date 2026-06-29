'use client'

import { motion } from 'framer-motion'

// 3D isometric payment flow diagram that slowly rotates
export function PaymentFlow3D() {
  const nodes = [
    { label: 'LivePay', x: 50, y: 10, color: '#4ade80', icon: '⚡' },
    { label: 'Payment Service', x: 50, y: 40, color: '#4ade80', icon: '🔄' },
    { label: 'SACCO', x: 20, y: 75, color: '#4ade80', icon: '🏦' },
    { label: 'Church', x: 50, y: 75, color: '#fbbf24', icon: '⛪' },
    { label: 'School', x: 80, y: 75, color: '#fb923c', icon: '🎓' },
  ]

  const connections = [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 1, to: 4 },
  ]

  return (
    <div className="scene-3d w-full">
      <motion.div
        initial={{ opacity: 0, rotateX: 25 }}
        animate={{ opacity: 1, rotateX: 25 }}
        transition={{ duration: 1 }}
        className="relative w-full"
        style={{ transformStyle: 'preserve-3d' }}
      >
        <svg viewBox="0 0 100 90" className="w-full max-w-md mx-auto" style={{ filter: 'drop-shadow(0 0 30px oklch(0.72 0.19 155 / 0.1))' }}>
          {/* Connection lines */}
          {connections.map((conn, i) => {
            const from = nodes[conn.from]
            const to = nodes[conn.to]
            return (
              <g key={i}>
                <motion.line
                  x1={from.x} y1={from.y}
                  x2={to.x} y2={to.y}
                  stroke="oklch(0.72 0.19 155)"
                  strokeWidth="0.3"
                  strokeDasharray="2 1"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 0.5 + i * 0.2, duration: 1 }}
                  opacity="0.4"
                />
                {/* Animated data particle flowing along line */}
                <motion.circle r="0.8" fill="#4ade80" opacity="0.8"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0.8, 0] }}
                  transition={{ delay: 2 + i * 0.5, duration: 2, repeat: Infinity, repeatDelay: 3 }}
                >
                  <animateMotion
                    dur="2s"
                    begin={`${2 + i * 0.5}s`}
                    repeatCount="indefinite"
                    path={`M${from.x},${from.y} L${to.x},${to.y}`}
                  />
                </motion.circle>
              </g>
            )
          })}

          {/* Nodes */}
          {nodes.map((node, i) => (
            <g key={i}>
              {/* Glow behind node */}
              <motion.circle
                cx={node.x} cy={node.y} r="6"
                fill={node.color} opacity="0.05"
                initial={{ r: 0 }}
                animate={{ r: [5, 7, 5] }}
                transition={{ delay: i * 0.2, duration: 3, repeat: Infinity }}
              />
              {/* Node background */}
              <motion.rect
                x={node.x - 12} y={node.y - 5}
                width="24" height="10" rx="2"
                fill="oklch(0.18 0.025 155)" stroke={node.color} strokeWidth="0.4"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3 + i * 0.15, type: 'spring', stiffness: 200 }}
              />
              {/* Node label */}
              <motion.text
                x={node.x} y={node.y + 1.5}
                textAnchor="middle"
                fill={node.color}
                fontSize="3"
                fontFamily="monospace"
                fontWeight="bold"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 + i * 0.15 }}
              >
                {node.label}
              </motion.text>
            </g>
          ))}

          {/* Data flow labels */}
          <motion.text x="50" y="22" textAnchor="middle" fill="oklch(0.58 0.03 150)" fontSize="2.5" fontFamily="monospace"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2 }}
          >
            webhook
          </motion.text>
          <motion.text x="30" y="58" textAnchor="middle" fill="oklch(0.58 0.03 150)" fontSize="2" fontFamily="monospace"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.5 }}
          >
            notify
          </motion.text>
          <motion.text x="70" y="58" textAnchor="middle" fill="oklch(0.58 0.03 150)" fontSize="2" fontFamily="monospace"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.5 }}
          >
            notify
          </motion.text>
        </svg>

        {/* 3D depth shadow */}
        <div className="absolute inset-0 translate-z-[-10px] opacity-10 blur-sm" style={{ transform: 'translateZ(-10px)' }}>
          <svg viewBox="0 0 100 90" className="w-full max-w-md mx-auto">
            {nodes.map((node, i) => (
              <rect key={i} x={node.x - 12} y={node.y - 5} width="24" height="10" rx="2" fill="#4ade80" opacity="0.3" />
            ))}
          </svg>
        </div>
      </motion.div>
    </div>
  )
}
