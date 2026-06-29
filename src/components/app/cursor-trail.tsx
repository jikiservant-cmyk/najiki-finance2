'use client'

import { useEffect, useRef } from 'react'

export function CursorTrail() {
  const posRef = useRef({ x: 0, y: 0 })
  
  useEffect(() => {
    const DOT_COUNT = 10

    const handleMouseMove = (e: MouseEvent) => {
      posRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('mousemove', handleMouseMove)

    const container = document.createElement('div')
    container.id = 'cursor-trail'
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;'
    document.body.appendChild(container)

    const dots: HTMLDivElement[] = []
    for (let i = 0; i < DOT_COUNT; i++) {
      const dot = document.createElement('div')
      dot.className = 'risograph-dot'
      const size = Math.max(3, 8 - i * 0.5)
      dot.style.width = `${size}px`
      dot.style.height = `${size}px`
      dot.style.opacity = String(Math.max(0.03, 0.25 - i * 0.025))
      container.appendChild(dot)
      dots.push(dot)
    }

    const positions = dots.map(() => ({ x: 0, y: 0 }))
    let frameId: number

    const animate = () => {
      positions[0] = { ...posRef.current }
      for (let i = 1; i < positions.length; i++) {
        positions[i].x += (positions[i - 1].x - positions[i].x) * 0.25
        positions[i].y += (positions[i - 1].y - positions[i].y) * 0.25
      }
      dots.forEach((dot, i) => {
        dot.style.transform = `translate(${positions[i].x - 4}px, ${positions[i].y - 4}px)`
      })
      frameId = requestAnimationFrame(animate)
    }
    frameId = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('mousemove', handleMouseMove)
      container.remove()
    }
  }, [])

  return null
}
