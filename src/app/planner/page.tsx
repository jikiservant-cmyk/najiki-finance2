'use client'

import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { FloatingGeometry } from '@/components/app/floating-geometry'
import { CursorTrail } from '@/components/app/cursor-trail'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { 
  Calendar as CalendarIcon, 
  Plus, 
  ChevronLeft, 
  ChevronRight, 
  CheckCircle2, 
  Circle, 
  Trash2, 
  Edit3, 
  Search, 
  Clock, 
  Tag, 
  Sparkles,
  Download,
  Upload,
  AlertCircle,
  FileText,
  CalendarDays,
  ListTodo
} from 'lucide-react'

export interface PlannerItem {
  id: string
  title: string
  notes: string
  date: string // ISO YYYY-MM-DD
  time?: string
  category: 'sacco_meeting' | 'settlement' | 'deadline' | 'maintenance' | 'general'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status: 'pending' | 'in_progress' | 'completed'
  color: 'emerald' | 'sky' | 'amber' | 'violet' | 'rose'
  createdAt: string
}

interface CalendarDayCell {
  dayNumber: number
  dateStr: string
  isCurrentMonth: boolean
}

const CATEGORY_LABELS: Record<PlannerItem['category'], string> = {
  sacco_meeting: 'SACCO Meeting',
  settlement: 'Settlement & Payout',
  deadline: 'Deadline',
  maintenance: 'System Audit',
  general: 'General Note',
}

const COLOR_MAP: Record<PlannerItem['color'], { bg: string; text: string; border: string; dot: string; lightBg: string }> = {
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400', lightBg: 'bg-emerald-500/20' },
  sky: { bg: 'bg-sky-500/15', text: 'text-sky-400', border: 'border-sky-500/30', dot: 'bg-sky-400', lightBg: 'bg-sky-500/20' },
  amber: { bg: 'bg-amber-500/15', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-400', lightBg: 'bg-amber-500/20' },
  violet: { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30', dot: 'bg-purple-400', lightBg: 'bg-purple-500/20' },
  rose: { bg: 'bg-rose-500/15', text: 'text-rose-400', border: 'border-rose-500/30', dot: 'bg-rose-400', lightBg: 'bg-rose-500/20' },
}

const INITIAL_SEED_ITEMS: PlannerItem[] = [
  {
    id: 'seed-1',
    title: 'Monthly SACCO Reconciliation & Audit',
    notes: 'Verify all completed LivePay payment intents against tenant merchant wallets. Confirm settlement ledger balances.',
    date: new Date().toISOString().split('T')[0],
    time: '10:00 AM',
    category: 'settlement',
    priority: 'high',
    status: 'pending',
    color: 'emerald',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'seed-2',
    title: 'K-Unity SACCO API Key Verification',
    notes: 'Meet with K-Unity admins to test webhook secret rotation and ensure member collection notifications arrive in real time.',
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    time: '02:30 PM',
    category: 'sacco_meeting',
    priority: 'medium',
    status: 'in_progress',
    color: 'sky',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'seed-3',
    title: 'Review Africa\'s Talking SMS Dispatch Logs',
    notes: 'Audit failed delivery receipts and check balance thresholds for member receipt dispatches.',
    date: new Date(Date.now() + 172800000).toISOString().split('T')[0],
    time: '11:00 AM',
    category: 'maintenance',
    priority: 'low',
    status: 'completed',
    color: 'amber',
    createdAt: new Date().toISOString(),
  },
]

export default function PlannerPage() {
  const [items, setItems] = useState<PlannerItem[]>([])
  const [isLoaded, setIsLoaded] = useState(false)
  const [currentDate, setCurrentDate] = useState<Date>(new Date())
  const [selectedDateStr, setSelectedDateStr] = useState<string>(new Date().toISOString().split('T')[0])
  
  // Search and filters
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('ALL')
  const [filterStatus, setFilterStatus] = useState<string>('ALL')
  const [activeView, setActiveView] = useState<'calendar' | 'notes'>('calendar')

  // Form modal/drawer state
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<PlannerItem | null>(null)

  // Form inputs
  const [formTitle, setFormTitle] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formDate, setFormDate] = useState(selectedDateStr)
  const [formTime, setFormTime] = useState('09:00 AM')
  const [formCategory, setFormCategory] = useState<PlannerItem['category']>('general')
  const [formPriority, setFormPriority] = useState<PlannerItem['priority']>('medium')
  const [formColor, setFormColor] = useState<PlannerItem['color']>('emerald')

  // Load from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('najiki_planner_items_v2')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setItems(parsed)
          setIsLoaded(true)
          return
        }
      }
      setItems(INITIAL_SEED_ITEMS)
      localStorage.setItem('najiki_planner_items_v2', JSON.stringify(INITIAL_SEED_ITEMS))
    } catch (e) {
      console.warn('Failed to load planner items:', e)
      setItems(INITIAL_SEED_ITEMS)
    } finally {
      setIsLoaded(true)
    }
  }, [])

  // Save to localStorage
  const persistItems = (newItems: PlannerItem[]) => {
    setItems(newItems)
    try {
      localStorage.setItem('najiki_planner_items_v2', JSON.stringify(newItems))
    } catch (e) {
      console.error('Failed to save to localStorage:', e)
    }
  }

  // Month navigation
  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))
  }
  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))
  }
  const goToToday = () => {
    const today = new Date()
    setCurrentDate(today)
    setSelectedDateStr(today.toISOString().split('T')[0])
  }

  // Calendar calculations
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const firstDayOfMonth = new Date(year, month, 1)
  const lastDayOfMonth = new Date(year, month + 1, 0)
  
  // Starting day index (0 = Sunday, 1 = Monday...)
  // Let's make Monday index 0:
  const startDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7
  const daysInMonth = lastDayOfMonth.getDate()

  // Preceding days from last month
  const prevMonthLastDate = new Date(year, month, 0).getDate()
  const prevDays: CalendarDayCell[] = []
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const d = prevMonthLastDate - i
    const dStr = new Date(year, month - 1, d).toISOString().split('T')[0]
    prevDays.push({ dayNumber: d, dateStr: dStr, isCurrentMonth: false })
  }

  // Current month days
  const currentMonthDays: CalendarDayCell[] = []
  for (let i = 1; i <= daysInMonth; i++) {
    // Format YYYY-MM-DD correctly with local offset
    const mm = String(month + 1).padStart(2, '0')
    const dd = String(i).padStart(2, '0')
    const dStr = `${year}-${mm}-${dd}`
    currentMonthDays.push({ dayNumber: i, dateStr: dStr, isCurrentMonth: true })
  }

  // Trailing days to fill 35 or 42 grid cells
  const totalCells = Math.ceil((prevDays.length + currentMonthDays.length) / 7) * 7
  const nextDaysCount = totalCells - (prevDays.length + currentMonthDays.length)
  const nextDays: CalendarDayCell[] = []
  for (let i = 1; i <= nextDaysCount; i++) {
    const mm = String(month + 2 > 12 ? 1 : month + 2).padStart(2, '0')
    const yyyy = month + 2 > 12 ? year + 1 : year
    const dd = String(i).padStart(2, '0')
    const dStr = `${yyyy}-${mm}-${dd}`
    nextDays.push({ dayNumber: i, dateStr: dStr, isCurrentMonth: false })
  }

  const allCalendarDays = [...prevDays, ...currentMonthDays, ...nextDays]

  // Map items by date for quick calendar marking lookup
  const itemsByDate = useMemo(() => {
    const map: Record<string, PlannerItem[]> = {}
    items.forEach((it) => {
      if (!map[it.date]) map[it.date] = []
      map[it.date].push(it)
    })
    return map
  }, [items])

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchesTitle = item.title.toLowerCase().includes(q)
        const matchesNotes = item.notes.toLowerCase().includes(q)
        if (!matchesTitle && !matchesNotes) return false
      }
      if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
      if (filterStatus !== 'ALL' && item.status !== filterStatus) return false
      return true
    })
  }, [items, searchQuery, filterCategory, filterStatus])

  // Items for the selected date
  const selectedDateItems = useMemo(() => {
    return items.filter((it) => it.date === selectedDateStr)
  }, [items, selectedDateStr])

  // Handlers
  const handleOpenNew = (dateOverride?: string) => {
    setEditingItem(null)
    setFormTitle('')
    setFormNotes('')
    setFormDate(dateOverride || selectedDateStr)
    setFormTime('09:00 AM')
    setFormCategory('general')
    setFormPriority('medium')
    setFormColor('emerald')
    setIsFormOpen(true)
  }

  const handleEdit = (item: PlannerItem) => {
    setEditingItem(item)
    setFormTitle(item.title)
    setFormNotes(item.notes)
    setFormDate(item.date)
    setFormTime(item.time || '09:00 AM')
    setFormCategory(item.category)
    setFormPriority(item.priority)
    setFormColor(item.color)
    setIsFormOpen(true)
  }

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formTitle.trim()) return

    if (editingItem) {
      const updated = items.map((it) =>
        it.id === editingItem.id
          ? {
              ...it,
              title: formTitle.trim(),
              notes: formNotes.trim(),
              date: formDate,
              time: formTime,
              category: formCategory,
              priority: formPriority,
              color: formColor,
            }
          : it
      )
      persistItems(updated)
    } else {
      const newItem: PlannerItem = {
        id: 'plan-' + Date.now(),
        title: formTitle.trim(),
        notes: formNotes.trim(),
        date: formDate,
        time: formTime,
        category: formCategory,
        priority: formPriority,
        status: 'pending',
        color: formColor,
        createdAt: new Date().toISOString(),
      }
      persistItems([newItem, ...items])
    }

    setIsFormOpen(false)
  }

  const handleDelete = (id: string) => {
    const updated = items.filter((it) => it.id !== id)
    persistItems(updated)
  }

  const handleToggleStatus = (id: string) => {
    const updated = items.map((it) => {
      if (it.id !== id) return it
      const nextStatus: PlannerItem['status'] =
        it.status === 'completed' ? 'pending' : 'completed'
      return { ...it, status: nextStatus }
    })
    persistItems(updated)
  }

  // Backup / Export
  const handleExport = () => {
    const jsonStr = JSON.stringify(items, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `najiki-planner-backup-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Stats
  const totalNotes = items.length
  const pendingCount = items.filter((i) => i.status !== 'completed').length
  const completedCount = items.filter((i) => i.status === 'completed').length
  const todayStr = new Date().toISOString().split('T')[0]
  const todayCount = items.filter((i) => i.date === todayStr).length

  return (
    <main className="min-h-screen relative text-foreground">
      <FloatingGeometry />
      <CursorTrail />
      <Navigation />

      <div className="pt-20 pb-16 px-6 md:px-12 lg:px-20 max-w-7xl mx-auto">
        {/* Header Ribbon */}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-6 border-b border-border/50">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono tracking-wider uppercase bg-primary/10 text-primary border border-primary/20">
                Operations & Schedule
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                Real-time Local Workspace
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-black tracking-tight flex items-center gap-3">
              Planner & Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Mark key operational dates, organize SACCO meeting schedules, track settlement deadlines, and retain operational notes.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="text-xs font-mono tracking-wider uppercase border-border/60 hover:bg-card flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Backup
            </Button>

            <Button
              size="sm"
              onClick={() => handleOpenNew()}
              className="bg-primary text-primary-foreground font-mono text-xs tracking-wider uppercase flex items-center gap-2 shadow-lg shadow-primary/20 hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              New Entry
            </Button>
          </div>
        </div>

        {/* Quick Stats Ribbon */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-6">
          <div className="bg-card/70 backdrop-blur-md border border-border/40 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5 text-primary" /> Today&apos;s Date
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-base font-bold text-foreground">
                {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <Badge variant="outline" className="text-[10px] font-mono text-primary border-primary/30">
                {todayCount} items
              </Badge>
            </div>
          </div>

          <div className="bg-card/70 backdrop-blur-md border border-border/40 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <ListTodo className="w-3.5 h-3.5 text-amber-400" /> Pending Action
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-black text-amber-400">{pendingCount}</span>
              <span className="text-xs text-muted-foreground font-mono">Tasks due</span>
            </div>
          </div>

          <div className="bg-card/70 backdrop-blur-md border border-border/40 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Completed
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-black text-emerald-400">{completedCount}</span>
              <span className="text-xs text-muted-foreground font-mono">Resolved</span>
            </div>
          </div>

          <div className="bg-card/70 backdrop-blur-md border border-border/40 rounded-xl p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-purple-400" /> Total Notes
            </span>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-black text-purple-400">{totalNotes}</span>
              <span className="text-xs text-muted-foreground font-mono">Records</span>
            </div>
          </div>
        </div>

        {/* View Switcher & Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-6">
          <div className="flex items-center gap-2 bg-card/60 p-1 rounded-lg border border-border/40 w-fit">
            <button
              type="button"
              onClick={() => setActiveView('calendar')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-mono tracking-wider uppercase transition-all flex items-center gap-2 ${
                activeView === 'calendar'
                  ? 'bg-primary text-primary-foreground font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarIcon className="w-3.5 h-3.5" />
              Calendar View
            </button>
            <button
              type="button"
              onClick={() => setActiveView('notes')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-mono tracking-wider uppercase transition-all flex items-center gap-2 ${
                activeView === 'notes'
                  ? 'bg-primary text-primary-foreground font-bold shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              All Notes & Planner ({filteredItems.length})
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="relative flex-1 sm:w-64">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search notes, SACCOs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-xs font-mono bg-card/80 border-border/40 focus:border-primary"
              />
            </div>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="h-9 px-2.5 text-xs font-mono bg-card/80 border border-border/40 rounded-md text-muted-foreground focus:text-foreground focus:border-primary outline-none"
            >
              <option value="ALL">All Categories</option>
              <option value="sacco_meeting">SACCO Meeting</option>
              <option value="settlement">Settlement & Payout</option>
              <option value="deadline">Deadline</option>
              <option value="maintenance">System Audit</option>
              <option value="general">General Note</option>
            </select>
          </div>
        </div>

        {/* MAIN BODY: CALENDAR VIEW VS ALL NOTES VIEW */}
        {activeView === 'calendar' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Calendar Grid (8 cols) */}
            <div className="lg:col-span-8 space-y-4">
              <Card className="border border-border/50 bg-card/70 backdrop-blur-xl shadow-xl">
                <CardHeader className="pb-3 border-b border-border/40">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-xl font-black tracking-tight">
                        {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                      </CardTitle>
                      <CardDescription className="text-xs font-mono mt-0.5">
                        Click any cell to mark dates or view daily notes
                      </CardDescription>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={goToToday}
                        className="h-8 text-[11px] font-mono tracking-wider uppercase border-border/50"
                      >
                        Today
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={prevMonth}
                        className="h-8 w-8 border-border/50"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={nextMonth}
                        className="h-8 w-8 border-border/50"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="p-3 sm:p-5">
                  {/* Day of Week Headers */}
                  <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-2">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                      <div
                        key={day}
                        className="text-center py-1.5 text-[11px] font-mono uppercase tracking-widest text-muted-foreground font-semibold"
                      >
                        {day}
                      </div>
                    ))}
                  </div>

                  {/* Calendar Matrix */}
                  <div className="grid grid-cols-7 gap-1 sm:gap-2">
                    {allCalendarDays.map((cell, idx) => {
                      const dayItems = itemsByDate[cell.dateStr] || []
                      const isSelected = cell.dateStr === selectedDateStr
                      const isToday = cell.dateStr === todayStr
                      const hasItems = dayItems.length > 0

                      return (
                        <motion.div
                          key={cell.dateStr + '-' + idx}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => setSelectedDateStr(cell.dateStr)}
                          className={`min-h-[74px] sm:min-h-[92px] p-1.5 sm:p-2 rounded-xl border flex flex-col justify-between transition-all cursor-pointer relative group ${
                            isSelected
                              ? 'border-primary bg-primary/10 shadow-md ring-1 ring-primary/40'
                              : isToday
                              ? 'border-emerald-500/50 bg-emerald-500/5 hover:border-emerald-500/80'
                              : cell.isCurrentMonth
                              ? 'border-border/30 bg-background/50 hover:bg-card/80 hover:border-border'
                              : 'border-border/10 bg-background/20 opacity-40 hover:opacity-75'
                          }`}
                        >
                          {/* Day Number and Badges */}
                          <div className="flex items-center justify-between">
                            <span
                              className={`text-xs sm:text-sm font-mono font-bold w-6 h-6 flex items-center justify-center rounded-full ${
                                isToday
                                  ? 'bg-emerald-500 text-black font-black shadow-xs'
                                  : isSelected
                                  ? 'bg-primary text-primary-foreground'
                                  : 'text-foreground/80'
                              }`}
                            >
                              {cell.dayNumber}
                            </span>

                            {hasItems && (
                              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-primary/20 text-primary border border-primary/30">
                                {dayItems.length}
                              </span>
                            )}
                          </div>

                          {/* Event Indicators / Dot Markers */}
                          <div className="mt-1 space-y-1">
                            {dayItems.slice(0, 2).map((item) => {
                              const style = COLOR_MAP[item.color] || COLOR_MAP.emerald
                              return (
                                <div
                                  key={item.id}
                                  className={`hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-sans truncate ${style.bg} ${style.text} border ${style.border}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${style.dot} shrink-0`} />
                                  <span className="truncate">{item.title}</span>
                                </div>
                              )
                            })}

                            {/* Mobile visual dots */}
                            <div className="flex sm:hidden items-center gap-1 justify-center pt-1">
                              {dayItems.slice(0, 3).map((item) => {
                                const style = COLOR_MAP[item.color] || COLOR_MAP.emerald
                                return (
                                  <span
                                    key={item.id}
                                    className={`w-1.5 h-1.5 rounded-full ${style.dot}`}
                                  />
                                )
                              })}
                            </div>

                            {dayItems.length > 2 && (
                              <span className="hidden sm:block text-[9px] font-mono text-muted-foreground pl-1">
                                +{dayItems.length - 2} more
                              </span>
                            )}
                          </div>
                        </motion.div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Legend Ribbon */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-card/40 rounded-xl border border-border/30 text-xs text-muted-foreground font-mono">
                <span className="font-semibold text-foreground/70">Category Markers:</span>
                <div className="flex flex-wrap items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> SACCO & Settlement
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> Meetings & Syncs
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> Deadlines & Tasks
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-purple-400" /> Planning & Notes
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-400" /> Critical / Urgent
                  </span>
                </div>
              </div>
            </div>

            {/* Selected Day Agenda & Quick Notes (4 cols) */}
            <div className="lg:col-span-4 space-y-4">
              <Card className="border border-border/50 bg-card/70 backdrop-blur-xl shadow-xl h-full flex flex-col justify-between">
                <CardHeader className="pb-3 border-b border-border/40">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-primary">
                        Day Agenda & Notes
                      </span>
                      <CardTitle className="text-lg font-black tracking-tight mt-0.5">
                        {new Date(selectedDateStr + 'T00:00:00').toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </CardTitle>
                    </div>

                    <Button
                      size="sm"
                      onClick={() => handleOpenNew(selectedDateStr)}
                      className="h-8 text-xs font-mono bg-primary text-primary-foreground gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Note
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="p-4 flex-1 overflow-y-auto max-h-[600px] space-y-3">
                  {selectedDateItems.length === 0 ? (
                    <div className="py-12 px-4 text-center flex flex-col items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-3">
                        <CalendarIcon className="w-6 h-6" />
                      </div>
                      <h4 className="text-sm font-bold text-foreground">No notes or entries</h4>
                      <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
                        Mark this date with a note, meeting agenda, or task deadline.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleOpenNew(selectedDateStr)}
                        className="mt-4 text-xs font-mono tracking-wider uppercase border-border/60"
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" /> Mark Date
                      </Button>
                    </div>
                  ) : (
                    selectedDateItems.map((item) => {
                      const colorStyle = COLOR_MAP[item.color] || COLOR_MAP.emerald
                      const isCompleted = item.status === 'completed'

                      return (
                        <motion.div
                          key={item.id}
                          layout
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          className={`p-3.5 rounded-xl border transition-all ${
                            isCompleted
                              ? 'bg-background/40 border-border/30 opacity-70'
                              : `${colorStyle.bg} ${colorStyle.border}`
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2.5 flex-1 min-w-0">
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(item.id)}
                                className="mt-0.5 text-muted-foreground hover:text-primary transition-colors shrink-0"
                              >
                                {isCompleted ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                ) : (
                                  <Circle className="w-4 h-4" />
                                )}
                              </button>

                              <div className="min-w-0 flex-1">
                                <h4
                                  className={`text-xs font-bold leading-tight ${
                                    isCompleted
                                      ? 'line-through text-muted-foreground'
                                      : 'text-foreground'
                                  }`}
                                >
                                  {item.title}
                                </h4>

                                {item.time && (
                                  <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1 mt-1">
                                    <Clock className="w-3 h-3 text-primary" />
                                    {item.time}
                                  </span>
                                )}

                                {item.notes && (
                                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line bg-background/50 p-2 rounded-md border border-border/20">
                                    {item.notes}
                                  </p>
                                )}

                                <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                  <Badge
                                    variant="outline"
                                    className={`text-[9px] font-mono uppercase ${colorStyle.text} ${colorStyle.border}`}
                                  >
                                    {CATEGORY_LABELS[item.category]}
                                  </Badge>

                                  <Badge
                                    variant="outline"
                                    className={`text-[9px] font-mono uppercase ${
                                      item.priority === 'urgent'
                                        ? 'text-rose-400 border-rose-500/40'
                                        : item.priority === 'high'
                                        ? 'text-amber-400 border-amber-500/40'
                                        : 'text-muted-foreground border-border/30'
                                    }`}
                                  >
                                    {item.priority}
                                  </Badge>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(item)}
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(item.id)}
                                className="h-7 w-7 text-muted-foreground hover:text-rose-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        </motion.div>
                      )
                    })
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        ) : (
          /* ALL NOTES & PLANNER LIST VIEW */
          <div className="space-y-4">
            <Card className="border border-border/50 bg-card/70 backdrop-blur-xl shadow-xl">
              <CardHeader className="pb-3 border-b border-border/40">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-xl font-black tracking-tight">
                      Master Notes & Planner Repository
                    </CardTitle>
                    <CardDescription className="text-xs font-mono mt-0.5">
                      Showing {filteredItems.length} entries matching search filters
                    </CardDescription>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value)}
                      className="h-8 px-2 text-xs font-mono bg-background/80 border border-border/40 rounded-md text-muted-foreground"
                    >
                      <option value="ALL">All Statuses</option>
                      <option value="pending">Pending</option>
                      <option value="completed">Completed</option>
                    </select>

                    <Button
                      size="sm"
                      onClick={() => handleOpenNew()}
                      className="h-8 text-xs font-mono bg-primary text-primary-foreground gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Note
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-4 sm:p-6">
                {filteredItems.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm font-semibold">No notes or planner entries match your filters</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('')
                        setFilterCategory('ALL')
                        setFilterStatus('ALL')
                      }}
                      className="mt-3 text-xs font-mono"
                    >
                      Clear Filters
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredItems.map((item) => {
                      const colorStyle = COLOR_MAP[item.color] || COLOR_MAP.emerald
                      const isCompleted = item.status === 'completed'

                      return (
                        <motion.div
                          key={item.id}
                          layout
                          className={`p-4 rounded-xl border flex flex-col justify-between transition-all ${
                            isCompleted
                              ? 'bg-background/40 border-border/30 opacity-70'
                              : `${colorStyle.bg} ${colorStyle.border}`
                          }`}
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <Badge
                                variant="outline"
                                className={`text-[10px] font-mono uppercase ${colorStyle.text} ${colorStyle.border}`}
                              >
                                {CATEGORY_LABELS[item.category]}
                              </Badge>

                              <span className="text-[10px] font-mono text-muted-foreground">
                                {new Date(item.date + 'T00:00:00').toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>

                            <div className="mt-2 flex items-start gap-2">
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(item.id)}
                                className="mt-0.5 text-muted-foreground hover:text-primary transition-colors shrink-0"
                              >
                                {isCompleted ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                ) : (
                                  <Circle className="w-4 h-4" />
                                )}
                              </button>

                              <h3
                                className={`text-sm font-bold leading-tight ${
                                  isCompleted
                                    ? 'line-through text-muted-foreground'
                                    : 'text-foreground'
                                }`}
                              >
                                {item.title}
                              </h3>
                            </div>

                            {item.notes && (
                              <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-3 bg-background/50 p-2.5 rounded-lg border border-border/20">
                                {item.notes}
                              </p>
                            )}
                          </div>

                          <div className="mt-4 pt-3 border-t border-border/20 flex items-center justify-between text-xs">
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {item.time || 'All Day'}
                            </span>

                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(item)}
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(item.id)}
                                className="h-7 w-7 text-muted-foreground hover:text-rose-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        </motion.div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* MODAL / DIALOG FORM FOR CREATING/EDITING ITEMS */}
        <AnimatePresence>
          {isFormOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 15 }}
                className="w-full max-w-lg bg-card border border-border shadow-2xl rounded-2xl p-6 relative overflow-hidden"
              >
                <div className="flex items-center justify-between pb-4 border-b border-border/40">
                  <div>
                    <h3 className="text-lg font-black tracking-tight">
                      {editingItem ? 'Edit Planner Note' : 'Add Note / Calendar Entry'}
                    </h3>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      Set details, date, category and color marker
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsFormOpen(false)}
                    className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground text-xs"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSaveForm} className="space-y-4 pt-4">
                  <div>
                    <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                      Title *
                    </label>
                    <Input
                      placeholder="e.g. K-Unity SACCO General Meeting"
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      className="h-10 text-sm bg-background border-border/60"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                        Date *
                      </label>
                      <Input
                        type="date"
                        value={formDate}
                        onChange={(e) => setFormDate(e.target.value)}
                        className="h-10 text-xs font-mono bg-background border-border/60"
                        required
                      />
                    </div>

                    <div>
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                        Time (Optional)
                      </label>
                      <Input
                        placeholder="e.g. 10:00 AM"
                        value={formTime}
                        onChange={(e) => setFormTime(e.target.value)}
                        className="h-10 text-xs font-mono bg-background border-border/60"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                        Category
                      </label>
                      <select
                        value={formCategory}
                        onChange={(e) => setFormCategory(e.target.value as any)}
                        className="w-full h-10 px-3 text-xs font-mono bg-background border border-border/60 rounded-md text-foreground outline-none"
                      >
                        <option value="sacco_meeting">SACCO Meeting</option>
                        <option value="settlement">Settlement & Payout</option>
                        <option value="deadline">Deadline</option>
                        <option value="maintenance">System Audit</option>
                        <option value="general">General Note</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                        Priority
                      </label>
                      <select
                        value={formPriority}
                        onChange={(e) => setFormPriority(e.target.value as any)}
                        className="w-full h-10 px-3 text-xs font-mono bg-background border border-border/60 rounded-md text-foreground outline-none"
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </div>
                  </div>

                  {/* Color Marker Selection */}
                  <div>
                    <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1.5">
                      Calendar Marker Color
                    </label>
                    <div className="flex items-center gap-3">
                      {(['emerald', 'sky', 'amber', 'violet', 'rose'] as PlannerItem['color'][]).map(
                        (col) => {
                          const isSelected = formColor === col
                          return (
                            <button
                              type="button"
                              key={col}
                              onClick={() => setFormColor(col)}
                              className={`h-8 px-3 rounded-md text-xs font-mono capitalize border flex items-center gap-1.5 transition-all ${
                                isSelected
                                  ? `${COLOR_MAP[col].bg} ${COLOR_MAP[col].text} ${COLOR_MAP[col].border} ring-2 ring-primary/40`
                                  : 'bg-background border-border/50 text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              <span className={`w-2 h-2 rounded-full ${COLOR_MAP[col].dot}`} />
                              {col}
                            </button>
                          )
                        }
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground block mb-1">
                      Notes / Description
                    </label>
                    <Textarea
                      placeholder="Enter detailed agenda, action points, contact references, or instructions..."
                      value={formNotes}
                      onChange={(e) => setFormNotes(e.target.value)}
                      rows={4}
                      className="text-xs font-mono bg-background border-border/60 resize-none"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsFormOpen(false)}
                      className="text-xs font-mono tracking-wider uppercase border-border/60"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      className="bg-primary text-primary-foreground text-xs font-mono tracking-wider uppercase"
                    >
                      {editingItem ? 'Update Note' : 'Save to Planner'}
                    </Button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </main>
  )
}
