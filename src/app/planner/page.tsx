'use client'

import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Navigation } from '@/components/app/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  Download, 
  CalendarDays, 
  ListFilter,
  Check,
  X,
  FileText,
  AlertCircle
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

const CATEGORY_META: Record<PlannerItem['category'], { label: string; colorClass: string }> = {
  sacco_meeting: { label: 'SACCO Meeting', colorClass: 'text-sky-400' },
  settlement: { label: 'Settlement & Payout', colorClass: 'text-emerald-400' },
  deadline: { label: 'Operational Deadline', colorClass: 'text-amber-400' },
  maintenance: { label: 'System Audit', colorClass: 'text-violet-400' },
  general: { label: 'General Note', colorClass: 'text-zinc-400' },
}

const PRIORITY_META: Record<PlannerItem['priority'], { label: string; dotClass: string }> = {
  urgent: { label: 'Urgent', dotClass: 'bg-rose-400' },
  high: { label: 'High Priority', dotClass: 'bg-amber-400' },
  medium: { label: 'Medium', dotClass: 'bg-sky-400' },
  low: { label: 'Low', dotClass: 'bg-zinc-400' },
}

const COLOR_STYLES: Record<PlannerItem['color'], { bar: string; badge: string; dot: string; text: string }> = {
  emerald: {
    bar: 'border-l-emerald-500 bg-emerald-500/10 text-emerald-300',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
  },
  sky: {
    bar: 'border-l-sky-500 bg-sky-500/10 text-sky-300',
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    dot: 'bg-sky-400',
    text: 'text-sky-400',
  },
  amber: {
    bar: 'border-l-amber-500 bg-amber-500/10 text-amber-300',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    dot: 'bg-amber-400',
    text: 'text-amber-400',
  },
  violet: {
    bar: 'border-l-violet-500 bg-violet-500/10 text-violet-300',
    badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    dot: 'bg-violet-400',
    text: 'text-violet-400',
  },
  rose: {
    bar: 'border-l-rose-500 bg-rose-500/10 text-rose-300',
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    dot: 'bg-rose-400',
    text: 'text-rose-400',
  },
}

function getTodayStr() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatDateHuman(dateStr: string) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function getRelativeDateLabel(dateStr: string, todayStr: string) {
  if (dateStr === todayStr) return 'Today'
  const today = new Date(todayStr)
  const target = new Date(dateStr)
  const diffTime = target.getTime() - today.getTime()
  const diffDays = Math.round(diffTime / (1000 * 3600 * 24))
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays > 1 && diffDays <= 7) return `In ${diffDays} days`
  if (diffDays < -1 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`
  return ''
}

const INITIAL_SEED_ITEMS: PlannerItem[] = [
  {
    id: 'seed-1',
    title: 'Monthly SACCO Reconciliation & Audit',
    notes: 'Verify all completed LivePay payment intents against tenant merchant wallets. Confirm settlement ledger balances.',
    date: getTodayStr(),
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
    notes: 'Meet with K-Unity technical team to verify webhook secret rotation and test collection callbacks in staging.',
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
    notes: 'Audit failed delivery receipts and check balance thresholds for member transaction notification dispatches.',
    date: new Date(Date.now() + 172800000).toISOString().split('T')[0],
    time: '11:00 AM',
    category: 'maintenance',
    priority: 'low',
    status: 'completed',
    color: 'amber',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'seed-4',
    title: 'Weekly Merchant Wallet Settlement Cut-off',
    notes: 'Lock transaction windows for batch payout export and post double-entry ledger transfers.',
    date: new Date(Date.now() + 259200000).toISOString().split('T')[0],
    time: '04:00 PM',
    category: 'settlement',
    priority: 'urgent',
    status: 'pending',
    color: 'rose',
    createdAt: new Date().toISOString(),
  },
]

export default function PlannerPage() {
  const [items, setItems] = useState<PlannerItem[]>([])
  const [currentDate, setCurrentDate] = useState<Date>(new Date())
  const todayStr = useMemo(() => getTodayStr(), [])
  const [selectedDateStr, setSelectedDateStr] = useState<string>(todayStr)

  // Filters & Views
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('ALL')
  const [filterStatus, setFilterStatus] = useState<string>('ALL')
  const [activeView, setActiveView] = useState<'calendar' | 'agenda'>('calendar')

  // Quick add input state for selected day
  const [quickTitle, setQuickTitle] = useState('')

  // Detailed Modal Form State
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<PlannerItem | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formDate, setFormDate] = useState(todayStr)
  const [formTime, setFormTime] = useState('09:00 AM')
  const [formCategory, setFormCategory] = useState<PlannerItem['category']>('general')
  const [formPriority, setFormPriority] = useState<PlannerItem['priority']>('medium')
  const [formColor, setFormColor] = useState<PlannerItem['color']>('emerald')

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('najiki_planner_items_v3')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setItems(parsed)
          return
        }
      }
      setItems(INITIAL_SEED_ITEMS)
      localStorage.setItem('najiki_planner_items_v3', JSON.stringify(INITIAL_SEED_ITEMS))
    } catch {
      setItems(INITIAL_SEED_ITEMS)
    }
  }, [])

  const persistItems = (newItems: PlannerItem[]) => {
    setItems(newItems)
    try {
      localStorage.setItem('najiki_planner_items_v3', JSON.stringify(newItems))
    } catch (e) {
      console.error('Failed to save planner items:', e)
    }
  }

  // Quick Add on the selected date
  const handleQuickAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!quickTitle.trim()) return

    const newItem: PlannerItem = {
      id: 'plan-' + Date.now(),
      title: quickTitle.trim(),
      notes: '',
      date: selectedDateStr,
      time: '09:00 AM',
      category: 'general',
      priority: 'medium',
      status: 'pending',
      color: 'emerald',
      createdAt: new Date().toISOString(),
    }

    persistItems([newItem, ...items])
    setQuickTitle('')
  }

  // Open modal for detailed creation or edit
  const handleOpenCreateModal = (dateOverride?: string) => {
    setEditingItem(null)
    setFormTitle('')
    setFormNotes('')
    setFormDate(dateOverride || selectedDateStr)
    setFormTime('10:00 AM')
    setFormCategory('settlement')
    setFormPriority('medium')
    setFormColor('emerald')
    setIsModalOpen(true)
  }

  const handleOpenEditModal = (item: PlannerItem) => {
    setEditingItem(item)
    setFormTitle(item.title)
    setFormNotes(item.notes)
    setFormDate(item.date)
    setFormTime(item.time || '10:00 AM')
    setFormCategory(item.category)
    setFormPriority(item.priority)
    setFormColor(item.color)
    setIsModalOpen(true)
  }

  const handleSaveModal = (e: React.FormEvent) => {
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
              time: formTime.trim(),
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
        time: formTime.trim(),
        category: formCategory,
        priority: formPriority,
        status: 'pending',
        color: formColor,
        createdAt: new Date().toISOString(),
      }
      persistItems([newItem, ...items])
      setSelectedDateStr(formDate)
    }

    setIsModalOpen(false)
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

  const handleExport = () => {
    const jsonStr = JSON.stringify(items, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `najiki-planner-export-${todayStr}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Calendar Math
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1))
  }
  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1))
  }
  const goToToday = () => {
    const today = new Date()
    setCurrentDate(today)
    setSelectedDateStr(todayStr)
  }

  const firstDayOfMonth = new Date(year, month, 1)
  const lastDayOfMonth = new Date(year, month + 1, 0)
  const startDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7 // Monday = 0
  const daysInMonth = lastDayOfMonth.getDate()

  const prevMonthLastDate = new Date(year, month, 0).getDate()
  const prevDays: CalendarDayCell[] = []
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const d = prevMonthLastDate - i
    const mm = String(month === 0 ? 12 : month).padStart(2, '0')
    const yyyy = month === 0 ? year - 1 : year
    const dd = String(d).padStart(2, '0')
    prevDays.push({ dayNumber: d, dateStr: `${yyyy}-${mm}-${dd}`, isCurrentMonth: false })
  }

  const currentMonthDays: CalendarDayCell[] = []
  for (let i = 1; i <= daysInMonth; i++) {
    const mm = String(month + 1).padStart(2, '0')
    const dd = String(i).padStart(2, '0')
    currentMonthDays.push({ dayNumber: i, dateStr: `${year}-${mm}-${dd}`, isCurrentMonth: true })
  }

  const totalCells = Math.ceil((prevDays.length + currentMonthDays.length) / 7) * 7
  const nextDaysCount = totalCells - (prevDays.length + currentMonthDays.length)
  const nextDays: CalendarDayCell[] = []
  for (let i = 1; i <= nextDaysCount; i++) {
    const mm = String(month + 2 > 12 ? 1 : month + 2).padStart(2, '0')
    const yyyy = month + 2 > 12 ? year + 1 : year
    const dd = String(i).padStart(2, '0')
    nextDays.push({ dayNumber: i, dateStr: `${yyyy}-${mm}-${dd}`, isCurrentMonth: false })
  }

  const allCalendarDays = [...prevDays, ...currentMonthDays, ...nextDays]

  // Indexed mapping for fast lookup
  const itemsByDate = useMemo(() => {
    const map: Record<string, PlannerItem[]> = {}
    items.forEach((it) => {
      if (!map[it.date]) map[it.date] = []
      map[it.date].push(it)
    })
    return map
  }, [items])

  // Filtered Items
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

  // Selected Date Items
  const selectedDateItems = useMemo(() => {
    return items
      .filter((it) => it.date === selectedDateStr)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
  }, [items, selectedDateStr])

  // Overview metrics
  const totalCount = items.length
  const pendingCount = items.filter((i) => i.status !== 'completed').length
  const completedCount = items.filter((i) => i.status === 'completed').length
  const urgentCount = items.filter((i) => (i.priority === 'urgent' || i.priority === 'high') && i.status !== 'completed').length

  const relativeLabel = getRelativeDateLabel(selectedDateStr, todayStr)

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Navigation />

      <main className="flex-1 pt-20 pb-16 px-4 sm:px-8 lg:px-12 max-w-7xl w-full mx-auto">
        {/* Editorial Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-border/60">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium mb-1">
              <span>Operations Gateway</span>
              <span aria-hidden="true">/</span>
              <span>Schedule & Planner</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
              Operations Planner
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-relaxed">
              Coordinate SACCO reconciliation schedules, settlement windows, and system audits in a focused workspace.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="text-xs h-9 gap-1.5 border-border/70 hover:bg-muted"
            >
              <Download className="w-3.5 h-3.5 text-muted-foreground" />
              <span>Export Schedule</span>
            </Button>
            <Button
              size="sm"
              onClick={() => handleOpenCreateModal()}
              className="text-xs h-9 gap-1.5 font-medium shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>New Event</span>
            </Button>
          </div>
        </div>

        {/* Human Metrics Overview Strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-0 border border-border/60 rounded-xl my-6 bg-card/40 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-border/60">
          <div className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">Today</p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg sm:text-xl font-semibold text-foreground">
                {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                · {itemsByDate[todayStr]?.length || 0} scheduled
              </span>
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">Pending Items</p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg sm:text-xl font-semibold text-amber-400 tabular-nums">
                {pendingCount}
              </span>
              <span className="text-xs text-muted-foreground">awaiting resolution</span>
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">Completed</p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg sm:text-xl font-semibold text-emerald-400 tabular-nums">
                {completedCount}
              </span>
              <span className="text-xs text-muted-foreground">audited & closed</span>
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">High Priority</p>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg sm:text-xl font-semibold text-rose-400 tabular-nums">
                {urgentCount}
              </span>
              <span className="text-xs text-muted-foreground">needs attention</span>
            </div>
          </div>
        </div>

        {/* View Controls & Filter Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-6">
          <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg border border-border/50 w-fit">
            <button
              type="button"
              onClick={() => setActiveView('calendar')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                activeView === 'calendar'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarIcon className="w-3.5 h-3.5" />
              <span>Month Calendar</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveView('agenda')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                activeView === 'agenda'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5" />
              <span>Agenda List ({filteredItems.length})</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 sm:w-60 min-w-[180px]">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search events or notes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-xs bg-card/60 border-border/60 focus-visible:ring-1"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="h-9 px-3 text-xs bg-card/60 border border-border/60 rounded-md text-foreground outline-none focus:border-primary"
            >
              <option value="ALL">All Categories</option>
              <option value="settlement">Settlement & Payout</option>
              <option value="sacco_meeting">SACCO Meetings</option>
              <option value="deadline">Operational Deadlines</option>
              <option value="maintenance">System Audits</option>
              <option value="general">General Notes</option>
            </select>
          </div>
        </div>

        {/* WORKSPACE CONTENT: CALENDAR VIEW */}
        {activeView === 'calendar' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Calendar Main Grid (8 cols) */}
            <div className="lg:col-span-8 border border-border/60 rounded-xl bg-card/40 overflow-hidden shadow-xs">
              {/* Month Navigation Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-card/60">
                <div className="flex items-center gap-2">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-foreground">
                    {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                  </h2>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={goToToday}
                    className="h-8 text-xs font-medium border-border/60 px-2.5"
                  >
                    Today
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={prevMonth}
                    aria-label="Previous month"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={nextMonth}
                    aria-label="Next month"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Day of Week Labels */}
              <div className="grid grid-cols-7 border-b border-border/40 bg-muted/20">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                  <div
                    key={day}
                    className="py-2.5 text-center text-xs font-medium text-muted-foreground"
                  >
                    {day}
                  </div>
                ))}
              </div>

              {/* Calendar Grid Matrix */}
              <div className="grid grid-cols-7 divide-x divide-y divide-border/30">
                {allCalendarDays.map((cell, idx) => {
                  const dayItems = itemsByDate[cell.dateStr] || []
                  const isSelected = cell.dateStr === selectedDateStr
                  const isToday = cell.dateStr === todayStr
                  const hasItems = dayItems.length > 0

                  return (
                    <div
                      key={cell.dateStr + '-' + idx}
                      onClick={() => setSelectedDateStr(cell.dateStr)}
                      className={`min-h-[82px] sm:min-h-[104px] p-2 flex flex-col justify-between transition-colors cursor-pointer select-none group relative ${
                        isSelected
                          ? 'bg-primary/5 ring-1 ring-inset ring-primary/40'
                          : cell.isCurrentMonth
                          ? 'bg-card/20 hover:bg-muted/40'
                          : 'bg-muted/10 opacity-40 hover:opacity-75'
                      }`}
                    >
                      {/* Top Row: Date Number and Quick Add on Hover */}
                      <div className="flex items-center justify-between">
                        <span
                          className={`w-6 h-6 flex items-center justify-center text-xs font-medium rounded-full tabular-nums ${
                            isToday
                              ? 'bg-primary text-primary-foreground font-semibold'
                              : isSelected
                              ? 'text-primary font-semibold'
                              : 'text-foreground/80'
                          }`}
                        >
                          {cell.dayNumber}
                        </span>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenCreateModal(cell.dateStr)
                          }}
                          aria-label={`Add item for ${cell.dateStr}`}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Event Snippets */}
                      <div className="mt-1.5 space-y-1">
                        {dayItems.slice(0, 2).map((item) => {
                          const col = COLOR_STYLES[item.color] || COLOR_STYLES.emerald
                          const isDone = item.status === 'completed'
                          return (
                            <div
                              key={item.id}
                              className={`px-1.5 py-0.5 rounded text-[11px] truncate flex items-center gap-1 border-l-2 ${col.bar} ${
                                isDone ? 'opacity-50 line-through' : ''
                              }`}
                            >
                              <span className="truncate">{item.title}</span>
                            </div>
                          )
                        })}

                        {dayItems.length > 2 && (
                          <p className="text-[10px] text-muted-foreground pl-1 font-medium">
                            +{dayItems.length - 2} more
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Quiet Footer Note */}
              <div className="px-5 py-3 border-t border-border/40 bg-muted/10 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Settlement
                  <span className="w-2 h-2 rounded-full bg-sky-400 ml-2" />
                  SACCO Meeting
                  <span className="w-2 h-2 rounded-full bg-amber-400 ml-2" />
                  Deadline
                  <span className="w-2 h-2 rounded-full bg-violet-400 ml-2" />
                  Audit
                </span>
                <span>Click any day to manage agenda</span>
              </div>
            </div>

            {/* Selected Day Agenda Desk (Right 4 cols) */}
            <div className="lg:col-span-4 border border-border/60 rounded-xl bg-card/50 overflow-hidden shadow-xs">
              <div className="p-4 sm:p-5 border-b border-border/50 bg-card/60">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                      <span>Day Schedule</span>
                      {relativeLabel && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-primary font-semibold">{relativeLabel}</span>
                        </>
                      )}
                    </div>
                    <h3 className="text-base sm:text-lg font-semibold text-foreground mt-0.5">
                      {formatDateHuman(selectedDateStr)}
                    </h3>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleOpenCreateModal(selectedDateStr)}
                    className="h-8 text-xs gap-1 border-border/70"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Details</span>
                  </Button>
                </div>

                {/* Quick Add Bar */}
                <form onSubmit={handleQuickAdd} className="mt-3.5 flex items-center gap-2">
                  <Input
                    placeholder="Quick add task or note..."
                    value={quickTitle}
                    onChange={(e) => setQuickTitle(e.target.value)}
                    className="h-8 text-xs bg-background/80 border-border/70"
                  />
                  <Button type="submit" size="sm" className="h-8 px-3 text-xs shrink-0 font-medium">
                    Add
                  </Button>
                </form>
              </div>

              {/* Items List */}
              <div className="p-4 space-y-2.5 max-h-[580px] overflow-y-auto">
                {selectedDateItems.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <CalendarDays className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-medium text-foreground">Clear schedule</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-[200px] mx-auto leading-relaxed">
                      No operational tasks scheduled for this day.
                    </p>
                  </div>
                ) : (
                  selectedDateItems.map((item) => {
                    const col = COLOR_STYLES[item.color] || COLOR_STYLES.emerald
                    const prio = PRIORITY_META[item.priority]
                    const isDone = item.status === 'completed'

                    return (
                      <div
                        key={item.id}
                        className={`p-3 rounded-lg border transition-all ${
                          isDone
                            ? 'bg-muted/30 border-border/40 opacity-70'
                            : 'bg-card border-border/60 hover:border-border'
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(item.id)}
                            aria-label={isDone ? 'Mark pending' : 'Mark completed'}
                            className="mt-0.5 text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                          >
                            {isDone ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <Circle className="w-4 h-4" />
                            )}
                          </button>

                          <div className="flex-1 min-w-0">
                            <p
                              className={`text-sm font-medium leading-snug ${
                                isDone ? 'line-through text-muted-foreground' : 'text-foreground'
                              }`}
                            >
                              {item.title}
                            </p>

                            {/* Clean Unboxed Metadata (Zero-Pill Discipline) */}
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground mt-1.5">
                              {item.time && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3 text-muted-foreground" />
                                  <span>{item.time}</span>
                                </span>
                              )}
                              {item.time && <span aria-hidden="true">·</span>}
                              <span className={CATEGORY_META[item.category].colorClass}>
                                {CATEGORY_META[item.category].label}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${prio.dotClass}`} />
                                <span>{prio.label}</span>
                              </span>
                            </div>

                            {item.notes && (
                              <p className="text-xs text-muted-foreground/90 mt-2 p-2 rounded bg-muted/40 border border-border/30 whitespace-pre-line leading-relaxed">
                                {item.notes}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleOpenEditModal(item)}
                              aria-label="Edit item"
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(item.id)}
                              aria-label="Delete item"
                              className="p-1 rounded text-muted-foreground hover:text-rose-400 hover:bg-muted"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        ) : (
          /* WORKSPACE CONTENT: AGENDA LIST VIEW */
          <div className="border border-border/60 rounded-xl bg-card/40 overflow-hidden shadow-xs">
            <div className="p-4 sm:p-5 border-b border-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card/60">
              <div>
                <h2 className="text-base sm:text-lg font-semibold text-foreground">
                  Chronological Agenda
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Showing {filteredItems.length} records ordered by date
                </p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="h-8 px-2.5 text-xs bg-card border border-border/60 rounded-md text-foreground"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="completed">Completed</option>
                </select>
                <Button
                  size="sm"
                  onClick={() => handleOpenCreateModal()}
                  className="h-8 text-xs font-medium gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Event</span>
                </Button>
              </div>
            </div>

            <div className="p-4 sm:p-6 divide-y divide-border/30">
              {filteredItems.length === 0 ? (
                <div className="py-16 text-center text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium text-foreground">No events found</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Try changing your category or search filter criteria.
                  </p>
                </div>
              ) : (
                filteredItems
                  .slice()
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .map((item) => {
                    const isDone = item.status === 'completed'
                    const prio = PRIORITY_META[item.priority]

                    return (
                      <div
                        key={item.id}
                        className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(item.id)}
                            className="mt-0.5 text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                          >
                            {isDone ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                            ) : (
                              <Circle className="w-4 h-4" />
                            )}
                          </button>

                          <div>
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span
                                className={`text-sm font-medium ${
                                  isDone ? 'line-through text-muted-foreground' : 'text-foreground'
                                }`}
                              >
                                {item.title}
                              </span>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {formatDateHuman(item.date)} {item.time && `· ${item.time}`}
                              </span>
                            </div>

                            {/* Clean Unboxed Metadata */}
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                              <span className={CATEGORY_META[item.category].colorClass}>
                                {CATEGORY_META[item.category].label}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${prio.dotClass}`} />
                                <span>{prio.label}</span>
                              </span>
                            </div>

                            {item.notes && (
                              <p className="text-xs text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
                                {item.notes}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 sm:self-center self-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenEditModal(item)}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Edit3 className="w-3.5 h-3.5 mr-1" /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(item.id)}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                          </Button>
                        </div>
                      </div>
                    )
                  })
              )}
            </div>
          </div>
        )}
      </main>

      {/* DETAILED CREATE / EDIT EVENT MODAL */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-lg bg-card border border-border shadow-2xl rounded-xl p-6 relative"
            >
              <div className="flex items-center justify-between pb-3.5 border-b border-border/50">
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {editingItem ? 'Edit Event & Note' : 'Add Operations Event'}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Configure operational timeline, category, and action details
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveModal} className="space-y-4 pt-4">
                <div>
                  <label className="text-xs font-medium text-foreground block mb-1">
                    Event Title *
                  </label>
                  <Input
                    placeholder="e.g. K-Unity SACCO Reconciliation Window"
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    className="h-9 text-xs bg-background"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1">
                      Event Date *
                    </label>
                    <Input
                      type="date"
                      value={formDate}
                      onChange={(e) => setFormDate(e.target.value)}
                      className="h-9 text-xs bg-background"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1">
                      Time
                    </label>
                    <Input
                      placeholder="e.g. 10:00 AM"
                      value={formTime}
                      onChange={(e) => setFormTime(e.target.value)}
                      className="h-9 text-xs bg-background"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1">
                      Category
                    </label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as any)}
                      className="w-full h-9 px-2.5 text-xs bg-background border border-border/70 rounded-md text-foreground outline-none focus:border-primary"
                    >
                      <option value="settlement">Settlement & Payout</option>
                      <option value="sacco_meeting">SACCO Meeting</option>
                      <option value="deadline">Operational Deadline</option>
                      <option value="maintenance">System Audit</option>
                      <option value="general">General Note</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1">
                      Priority
                    </label>
                    <select
                      value={formPriority}
                      onChange={(e) => setFormPriority(e.target.value as any)}
                      className="w-full h-9 px-2.5 text-xs bg-background border border-border/70 rounded-md text-foreground outline-none focus:border-primary"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-foreground block mb-1.5">
                    Accent Color
                  </label>
                  <div className="flex items-center gap-2">
                    {(['emerald', 'sky', 'amber', 'violet', 'rose'] as PlannerItem['color'][]).map(
                      (col) => {
                        const isSelected = formColor === col
                        const style = COLOR_STYLES[col]
                        return (
                          <button
                            type="button"
                            key={col}
                            onClick={() => setFormColor(col)}
                            className={`h-7 px-2.5 rounded-md text-xs capitalize border flex items-center gap-1.5 transition-all ${
                              isSelected
                                ? `${style.badge} ring-1 ring-primary/40 font-medium`
                                : 'bg-background border-border/60 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                            <span>{col}</span>
                          </button>
                        )
                      }
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-foreground block mb-1">
                    Notes & Action Points
                  </label>
                  <Textarea
                    placeholder="Add details, contact points, reconciliation checklist, or meeting links..."
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    rows={3}
                    className="text-xs bg-background resize-none"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/50">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsModalOpen(false)}
                    className="text-xs h-8 border-border/70"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" className="text-xs h-8 font-medium">
                    {editingItem ? 'Save Changes' : 'Create Event'}
                  </Button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
