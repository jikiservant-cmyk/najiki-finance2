'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Navigation } from '@/components/app/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { 
  ChevronLeft, 
  ChevronRight, 
  Calendar as CalendarIcon, 
  CheckCircle2, 
  Trash2, 
  Download, 
  Upload, 
  RotateCcw,
  Sparkles,
  BarChart2,
  CalendarDays,
  Clock,
  ArrowRight,
  Filter
} from 'lucide-react'

export interface TaskItem {
  id: string | number
  text: string
  cat: 'skill' | 'biz' | 'ops'
  done: boolean
}

type TrackerStore = Record<string, TaskItem[]>

const STORAGE_KEY = 'discipline-tracker-v1'

const CATEGORY_CONFIG: Record<TaskItem['cat'], { name: string; color: string; bg: string; border: string }> = {
  skill: { 
    name: 'Skills', 
    color: '#3b82f6', 
    bg: 'bg-blue-500/10 text-blue-400',
    border: 'border-blue-500/30'
  },
  biz: { 
    name: 'Business', 
    color: '#f59e0b', 
    bg: 'bg-amber-500/10 text-amber-400',
    border: 'border-amber-500/30'
  },
  ops: { 
    name: 'Operations & Finance', 
    color: '#10b981', 
    bg: 'bg-emerald-500/10 text-emerald-400',
    border: 'border-emerald-500/30'
  },
}

function dateToKey(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDayTitle(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

function calculatePercentage(tasks: TaskItem[]): number {
  if (!tasks || tasks.length === 0) return 0
  const completed = tasks.filter((t) => t.done).length
  return Math.round((completed / tasks.length) * 100)
}

export default function PlannerPage() {
  const [data, setData] = useState<TrackerStore>({})
  const [isLoaded, setIsLoaded] = useState(false)
  const [currentDate, setCurrentDate] = useState<Date>(new Date())
  
  // Task input state
  const [inputText, setInputText] = useState('')
  const [selectedCat, setSelectedCat] = useState<TaskItem['cat']>('skill')

  // History / Date Explorer drawer state
  const [showHistory, setShowHistory] = useState(false)

  const currentKey = useMemo(() => dateToKey(currentDate), [currentDate])
  const todayKey = useMemo(() => dateToKey(new Date()), [])
  const isToday = currentKey === todayKey

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed && typeof parsed === 'object') {
          setData(parsed)
          setIsLoaded(true)
          return
        }
      }
      
      // Default seed data for today if nothing stored yet
      const initialSeed: TrackerStore = {
        [todayKey]: [
          { id: 101, text: 'Review LivePay webhook signature algorithm', cat: 'skill', done: true },
          { id: 102, text: 'Audit SACCO settlement wallet account balances', cat: 'biz', done: true },
          { id: 103, text: 'Inspect Africa\'s Talking SMS delivery reports', cat: 'ops', done: false },
          { id: 104, text: 'Complete state persistence architecture', cat: 'skill', done: false },
        ],
      }
      setData(initialSeed)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initialSeed))
    } catch {
      setData({})
    } finally {
      setIsLoaded(true)
    }
  }, [todayKey])

  // Save changes to localStorage immediately
  const persistStore = useCallback((updated: TrackerStore) => {
    setData(updated)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    } catch (e) {
      console.error('Failed to save to localStorage:', e)
    }
  }, [])

  // Current day tasks and metrics
  const currentTasks = useMemo(() => {
    return data[currentKey] || []
  }, [data, currentKey])

  const totalPercentage = useMemo(() => {
    return calculatePercentage(currentTasks)
  }, [currentTasks])

  // Category counts and percentages
  const categoryStats = useMemo(() => {
    const categories: TaskItem['cat'][] = ['skill', 'biz', 'ops']
    return categories.map((cat) => {
      const tasks = currentTasks.filter((t) => t.cat === cat)
      const done = tasks.filter((t) => t.done).length
      const pct = calculatePercentage(tasks)
      return {
        cat,
        config: CATEGORY_CONFIG[cat],
        tasks,
        total: tasks.length,
        done,
        pct,
      }
    })
  }, [currentTasks])

  // Handle adding task
  const handleAddTask = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const text = inputText.trim()
    if (!text) return

    const newTask: TaskItem = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      text,
      cat: selectedCat,
      done: false,
    }

    setData((prev) => {
      const existing = prev[currentKey] || []
      const nextList = [...existing, newTask]
      const nextStore = { ...prev, [currentKey]: nextList }
      persistStore(nextStore)
      return nextStore
    })

    setInputText('')
  }

  // Handle toggling done status
  const handleToggleTask = (id: string | number) => {
    setData((prev) => {
      const existing = prev[currentKey] || []
      const nextList = existing.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
      const nextStore = { ...prev, [currentKey]: nextList }
      persistStore(nextStore)
      return nextStore
    })
  }

  // Handle deleting task
  const handleDeleteTask = (id: string | number) => {
    setData((prev) => {
      const existing = prev[currentKey] || []
      const nextList = existing.filter((t) => t.id !== id)
      const nextStore = { ...prev, [currentKey]: nextList }
      persistStore(nextStore)
      return nextStore
    })
  }

  // Day navigation
  const handlePrevDay = () => {
    const next = new Date(currentDate)
    next.setDate(next.getDate() - 1)
    setCurrentDate(next)
  }

  const handleNextDay = () => {
    const next = new Date(currentDate)
    next.setDate(next.getDate() + 1)
    setCurrentDate(next)
  }

  const handleGoToToday = () => {
    setCurrentDate(new Date())
  }

  const handleSelectDateString = (dateStr: string) => {
    if (!dateStr) return
    setCurrentDate(keyToDate(dateStr))
  }

  // 7 Days Performance Columns
  const last7Days = useMemo(() => {
    const days: { date: Date; key: string; pct: number; total: number; isSelected: boolean }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(currentDate)
      d.setDate(d.getDate() - i)
      const k = dateToKey(d)
      const tasks = data[k] || []
      const pct = calculatePercentage(tasks)
      days.push({
        date: d,
        key: k,
        pct,
        total: tasks.length,
        isSelected: k === currentKey,
      })
    }
    return days
  }, [currentDate, data, currentKey])

  // All recorded dates list for historical organization
  const recordedDatesList = useMemo(() => {
    const keys = Object.keys(data).filter((k) => (data[k] || []).length > 0)
    keys.sort((a, b) => b.localeCompare(a)) // Newest dates first
    return keys.map((k) => {
      const tasks = data[k] || []
      const pct = calculatePercentage(tasks)
      const done = tasks.filter((t) => t.done).length
      return {
        key: k,
        date: keyToDate(k),
        tasks,
        total: tasks.length,
        done,
        pct,
        isCurrent: k === currentKey,
      }
    })
  }, [data, currentKey])

  // Export data
  const handleExportData = () => {
    const jsonStr = JSON.stringify(data, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `discipline-tracker-data-${todayKey}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col antialiased">
      <Navigation />

      <main className="flex-1 pt-20 pb-20 px-4 sm:px-6 max-w-xl w-full mx-auto space-y-4">
        {/* Top Header & History Toggle */}
        <div className="flex items-center justify-between px-1">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <span>Discipline Tracker</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Daily habit and execution tracker with date-based organization.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs h-8 px-2.5 gap-1.5 border-border/80 text-muted-foreground hover:text-foreground"
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>{showHistory ? 'Hide Dates' : 'All Dates'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExportData}
              title="Backup your tasks to JSON"
              className="text-xs h-8 px-2 text-muted-foreground hover:text-foreground"
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* ===================================================================
           1. DATE NAVIGATION CARD
           =================================================================== */}
        <div className="bg-card border border-border/70 rounded-2xl p-4 shadow-xs flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handlePrevDay}
            aria-label="Previous day"
            className="h-9 w-9 rounded-xl border-border/70 text-muted-foreground hover:text-foreground shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>

          <div className="text-center flex-1 min-w-0">
            <h2 className="text-base sm:text-lg font-bold tracking-tight text-foreground truncate">
              {formatDayTitle(currentDate)}
            </h2>
            <div className="flex items-center justify-center gap-2 mt-0.5">
              <span className="text-xs text-muted-foreground font-medium">
                {isToday ? 'Today' : currentKey}
              </span>
              {!isToday && (
                <button
                  type="button"
                  onClick={handleGoToToday}
                  className="text-xs text-primary hover:underline font-semibold"
                >
                  Return to Today
                </button>
              )}
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleNextDay}
            aria-label="Next day"
            className="h-9 w-9 rounded-xl border-border/70 text-muted-foreground hover:text-foreground shrink-0"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        {/* Quick Date Selector Input (Direct date picker) */}
        <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-medium">
            <CalendarIcon className="w-3.5 h-3.5" /> Jump to specific date:
          </span>
          <input
            type="date"
            value={currentKey}
            onChange={(e) => handleSelectDateString(e.target.value)}
            className="bg-card border border-border/70 rounded-lg px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
          />
        </div>

        {/* ===================================================================
           2. BIG CIRCULAR RING & CATEGORY PROGRESS CARD
           =================================================================== */}
        <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs flex items-center gap-6">
          {/* SVG Ring (radius 40, circumference 251.3) */}
          <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
              {/* Background Track */}
              <circle
                cx="48"
                cy="48"
                r="40"
                fill="none"
                stroke="currentColor"
                strokeWidth="10"
                className="text-muted/20"
              />
              {/* Animated Progress Arc */}
              <circle
                cx="48"
                cy="48"
                r="40"
                fill="none"
                stroke="currentColor"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray="251.3"
                strokeDashoffset={251.3 * (1 - totalPercentage / 100)}
                className="text-emerald-500 transition-all duration-500 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-xl font-bold tracking-tight text-foreground tabular-nums">
                {totalPercentage}%
              </span>
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                Total
              </span>
            </div>
          </div>

          {/* Category Progress Bars */}
          <div className="flex-1 space-y-3">
            {categoryStats.map(({ cat, config, total, done, pct }) => (
              <div key={cat} className="space-y-1">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="text-foreground flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: config.color }}
                    />
                    {config.name}
                  </span>
                  <span className="text-muted-foreground tabular-nums text-[11px]">
                    {done}/{total} · {pct}%
                  </span>
                </div>
                <div className="h-2 w-full bg-muted/25 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: config.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===================================================================
           3. ADD TASK CARD (Frictionless input + category select + Add button)
           =================================================================== */}
        <div className="bg-card border border-border/70 rounded-2xl p-4 shadow-xs">
          <form onSubmit={handleAddTask} className="flex gap-2 flex-wrap sm:flex-nowrap">
            <Input
              id="inp"
              placeholder="Add a task..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddTask()
                }
              }}
              maxLength={120}
              className="flex-1 min-w-[140px] h-10 text-xs bg-background border-border/80 rounded-xl"
            />
            <select
              id="cat"
              value={selectedCat}
              onChange={(e) => setSelectedCat(e.target.value as TaskItem['cat'])}
              className="h-10 px-3 text-xs bg-background border border-border/80 rounded-xl text-foreground outline-none shrink-0"
            >
              <option value="skill">Skill</option>
              <option value="biz">Business</option>
              <option value="ops">Operations</option>
            </select>
            <Button
              id="addbtn"
              type="submit"
              onClick={handleAddTask}
              className="h-10 px-5 text-xs font-semibold rounded-xl shrink-0"
            >
              Add
            </Button>
          </form>
        </div>

        {/* ===================================================================
           4. CATEGORIZED TASK BOARDS (Skills, Business, Operations)
           =================================================================== */}
        {categoryStats.map(({ cat, config, tasks }) => (
          <div
            key={cat}
            className="bg-card border border-border/70 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3"
          >
            <div className="flex items-center justify-between border-b border-border/40 pb-2.5">
              <h2 className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: config.color }}
                />
                {config.name}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {tasks.filter((t) => t.done).length}/{tasks.length} Done
              </span>
            </div>

            {tasks.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 text-center">
                No tasks yet.
              </p>
            ) : (
              <div className="divide-y divide-border/30">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 py-2.5 group transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={task.done}
                      onChange={() => handleToggleTask(task.id)}
                      className="w-4 h-4 rounded text-emerald-500 accent-emerald-500 cursor-pointer shrink-0"
                    />
                    <span
                      className={`flex-1 text-xs break-words transition-all ${
                        task.done
                          ? 'line-through text-muted-foreground'
                          : 'text-foreground font-medium'
                      }`}
                    >
                      {task.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteTask(task.id)}
                      aria-label="Delete task"
                      className="text-muted-foreground hover:text-rose-400 p-1 text-lg leading-none transition-colors opacity-70 group-hover:opacity-100"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* ===================================================================
           5. LAST 7 DAYS HISTORY BAR CHART CARD
           =================================================================== */}
        <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs">
          <div className="flex items-center justify-between mb-2 border-b border-border/40 pb-2">
            <h2 className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5" /> Last 7 Days
            </h2>
            <span className="text-[11px] text-muted-foreground">Click a day to view</span>
          </div>

          <div className="flex items-end gap-2 h-28 pt-4">
            {last7Days.map((col) => {
              return (
                <div
                  key={col.key}
                  onClick={() => setCurrentDate(new Date(col.date))}
                  className={`flex-1 flex flex-col items-center justify-end h-full text-[11px] cursor-pointer group transition-all ${
                    col.isSelected ? 'text-primary font-bold' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <small className="text-[10px] tabular-nums mb-1 font-mono">
                    {col.total > 0 ? `${col.pct}%` : ''}
                  </small>
                  <div
                    className={`w-full rounded-t-md transition-all duration-300 ${
                      col.isSelected
                        ? 'bg-emerald-500 ring-2 ring-foreground/40'
                        : col.pct > 0
                        ? 'bg-emerald-500/80 group-hover:bg-emerald-500'
                        : 'bg-muted/30'
                    }`}
                    style={{ height: `${Math.max(col.pct, 3)}%` }}
                  />
                  <span className="mt-2 text-[10px] font-medium uppercase">
                    {col.date.toLocaleDateString('en-US', { weekday: 'short' })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ===================================================================
           6. ALL DATES & HISTORICAL ARCHIVE (Organized basing on dates)
           =================================================================== */}
        {showHistory && (
          <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-border/40 pb-2.5">
              <h2 className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5" /> All Recorded Dates ({recordedDatesList.length})
              </h2>
              <span className="text-xs text-muted-foreground">Ordered newest first</span>
            </div>

            {recordedDatesList.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No recorded tasks found yet. Add some tasks above!
              </p>
            ) : (
              <div className="divide-y divide-border/30 max-h-64 overflow-y-auto">
                {recordedDatesList.map((entry) => (
                  <div
                    key={entry.key}
                    onClick={() => {
                      setCurrentDate(entry.date)
                      setShowHistory(false)
                    }}
                    className={`py-2.5 px-2 flex items-center justify-between text-xs rounded-lg cursor-pointer transition-colors ${
                      entry.isCurrent
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'hover:bg-muted/40 text-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums font-mono">{entry.key}</span>
                      <span className="text-muted-foreground text-[11px]">
                        ({entry.date.toLocaleDateString('en-US', { weekday: 'short' })})
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground tabular-nums">
                        {entry.done}/{entry.total} tasks
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${
                          entry.pct === 100
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : entry.pct > 0
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {entry.pct}%
                      </span>
                      <ArrowRight className="w-3 h-3 text-muted-foreground" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
