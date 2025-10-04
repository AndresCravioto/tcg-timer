import React, { useEffect, useMemo, useRef, useState } from "react"

// --- Types ---
type TimerStatus = "RUNNING" | "PAUSED" | "FINISHED"

type GameTimer = {
  id: string
  game: string
  icon?: string // URL or emoji
  durationSec: number
  remainingSec: number
  status: TimerStatus
  announceAt: number[] // seconds remaining at which to announce (e.g., [300, 120])
}

// --- Utilities ---
const pad = (n: number) => String(n).padStart(2, "0")
const formatHHMMSS = (totalSeconds: number) => {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

const PRESETS: { label: string; icon: string; minutes: number }[] = [
  { label: "One Piece TCG", icon: "🟡", minutes: 30 },
  { label: "Magic: The Gathering", icon: "🧙", minutes: 50 },
  { label: "Pokémon TCG", icon: "⚡", minutes: 50 },
  { label: "Yu‑Gi‑Oh!", icon: "🜲", minutes: 45 },
  { label: "Flesh and Blood", icon: "🛡️", minutes: 50 },
  { label: "Lorcana", icon: "✨", minutes: 50 },
]

// Speech synthesis helper with a small queue so we don't overlap announcements.
function useSpeech(enabled: boolean, voiceName?: string) {
  const queue = useRef<string[]>([])
  const speaking = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => {
      if (speaking.current) return
      const next = queue.current.shift()
      if (!next) return
      const utter = new SpeechSynthesisUtterance(next)
      if (voiceName) {
        const v = window.speechSynthesis.getVoices().find((x) => x.name === voiceName)
        if (v) utter.voice = v
      }
      speaking.current = true
      utter.onend = () => (speaking.current = false)
      window.speechSynthesis.speak(utter)
    }, 250)
    return () => clearInterval(t)
  }, [enabled, voiceName])

  return (text: string) => {
    if (!enabled) return
    queue.current.push(text)
  }
}

// Backdrop uploader (stores a data URL in localStorage)
function useBackdrop() {
  const [bg, setBg] = useState<string | undefined>(() => localStorage.getItem("tcg_bg") || undefined)
  const onFile = async (file: File) => {
    const buf = await file.arrayBuffer()
    const blob = new Blob([buf])
    const url = await new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsDataURL(blob)
    })
    localStorage.setItem("tcg_bg", url)
    setBg(url)
  }
  const clear = () => {
    localStorage.removeItem("tcg_bg")
    setBg(undefined)
  }
  return { bg, onFile, clear }
}

// Persist timers to localStorage so refreshes don't nuke your setup.
function usePersistentTimers() {
  const [timers, setTimers] = useState<GameTimer[]>(() => {
    const raw = localStorage.getItem("tcg_timers")
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as GameTimer[]
      return parsed
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem("tcg_timers", JSON.stringify(timers))
  }, [timers])

  return [timers, setTimers] as const
}

// --- Main Component ---
export default function TimerBoard() {
  const [timers, setTimers] = usePersistentTimers()
  const [showAdmin, setShowAdmin] = useState(true)
  const [tickRateMs, setTickRateMs] = useState(1000)
  const [overlay, setOverlay] = useState<string | null>(null)
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [voiceName, setVoiceName] = useState<string | undefined>(undefined)
  const speak = useSpeech(speechEnabled, voiceName)
  const { bg, onFile, onFile: onBackdropFile, clear: clearBackdrop } = useBackdrop()

  // Ticking
  useEffect(() => {
    const t = setInterval(() => {
      setTimers((prev) =>
        prev.map((tm) => {
          if (tm.status !== "RUNNING") return tm
          const next = Math.max(0, tm.remainingSec - tickRateMs / 1000)
          return { ...tm, remainingSec: next, status: next <= 0 ? "FINISHED" : tm.status }
        })
      )
    }, tickRateMs)
    return () => clearInterval(t)
  }, [setTimers, tickRateMs])

  // Announcements + Overlay when crossing milestones
  const lastSeen = useRef<Record<string, number>>({})
  useEffect(() => {
    timers.forEach((tm) => {
      if (tm.status === "FINISHED") {
        if (lastSeen.current[tm.id] !== -1) {
          announce(`${tm.game}, time! Please finish your current action.`)
          setOverlay(`${tm.game}: TIME!`)
          lastSeen.current[tm.id] = -1
          setTimeout(() => setOverlay(null), 5000)
        }
        return
      }
      const prev = lastSeen.current[tm.id]
      const remaining = Math.ceil(tm.remainingSec)
      if (tm.announceAt.includes(remaining) && prev !== remaining) {
        if (remaining === 300) announce(`${tm.game}, les quedan 5 minutos.`)
        else if (remaining === 120) announce(`${tm.game}, les quedan 2 minutos.`)
        else announce(`${tm.game}, ${Math.floor(remaining / 60)} minutos restantes.`)
        setOverlay(`${tm.game}: ${formatHHMMSS(remaining)} left`)
        setTimeout(() => setOverlay(null), 3500)
      }
      lastSeen.current[tm.id] = remaining
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timers])

  function announce(text: string) {
    speak(text)
  }

  function addTimer(preset?: { game?: string; icon?: string; minutes?: number }) {
    const id = crypto.randomUUID()
    const duration = (preset?.minutes ?? 50) * 60
    const nt: GameTimer = {
      id,
      game: preset?.game || "Untitled Game",
      icon: preset?.icon,
      durationSec: duration,
      remainingSec: duration,
      status: "PAUSED",
      announceAt: [300, 120],
    }
    setTimers((t) => [...t, nt])
  }

  function updateTimer(id: string, patch: Partial<GameTimer>) {
    setTimers((t) => t.map((x) => (x.id == id ? { ...x, ...patch } : x)))
  }

  function removeTimer(id: string) {
    setTimers((t) => t.filter((x) => x.id != id))
    delete lastSeen.current[id]
  }

  const runningCount = useMemo(() => timers.filter((t) => t.status !== "FINISHED").length, [timers])

  return (
    <div className="w-full min-h-screen relative text-white">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30"
        style={{ backgroundImage: bg ? `url(${bg})` : "linear-gradient(135deg,#0f172a,#1e293b)" }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto p-4">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold drop-shadow">TCG Store Timers</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAdmin((v) => !v)}
              className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20"
              title="Toggle admin controls"
            >
              {showAdmin ? "Hide Admin" : "Show Admin"}
            </button>
            <label className="flex items-center gap-2 text-sm bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              <input
                type="checkbox"
                checked={speechEnabled}
                onChange={(e) => setSpeechEnabled(e.target.checked)}
              />
              Voice
            </label>
          </div>
        </header>

        {/* Fullscreen toggle */}
        <div className="mt-2">
          <button
            onClick={() => {
              if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {})
              } else {
                document.exitFullscreen().catch(() => {})
              }
            }}
            className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
          >
            Toggle Fullscreen
          </button>
        </div>

        {showAdmin && (
          <AdminPanel
            onAddTimer={addTimer}
            setTickRateMs={setTickRateMs}
            voiceName={voiceName}
            setVoiceName={setVoiceName}
            onBackdropFile={(f) => onBackdropFile(f)}
            clearBackdrop={clearBackdrop}
          />
        )}

        {/* Timers Grid */}
        <div className={`grid ${runningCount <= 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"} gap-4 mt-4`}>
          {timers.map((tm) => (
            <TimerCard
              key={tm.id}
              timer={tm}
              onUpdate={updateTimer}
              onRemove={removeTimer}
            />
          ))}
          {timers.length === 0 && (
            <div className="rounded-3xl p-8 bg-black/30 border border-white/10 text-center">
              <p className="opacity-90">No timers yet. Use the admin panel to add a game timer.</p>
            </div>
          )}
        </div>
      </div>

      {/* Big overlay for milestones */}
      {overlay && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur">
          <div className="text-5xl md:text-7xl font-extrabold text-white drop-shadow-xl animate-pulse">{overlay}</div>
        </div>
      )}
    </div>
  )
}

function TimerCard({
  timer,
  onUpdate,
  onRemove,
}: {
  timer: GameTimer
  onUpdate: (id: string, patch: Partial<GameTimer>) => void
  onRemove: (id: string) => void
}) {
  const pct = Math.max(0, Math.min(100, 100 * (timer.remainingSec / timer.durationSec)))
  const isLow = timer.remainingSec <= 120 && timer.status !== "FINISHED"

  return (
    <div className={`rounded-3xl overflow-hidden border ${isLow ? "border-red-400/60" : "border-white/10"} bg-white/5`}>
      <div className="p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-3xl" title={timer.game}>{timer.icon || "🎮"}</div>
          <div>
            <div className="text-xl font-semibold leading-tight">{timer.game}</div>
            <div className="text-xs opacity-80">Total: {formatHHMMSS(timer.durationSec)}</div>
          </div>
        </div>
        <button
          onClick={() => onRemove(timer.id)}
          className="text-sm px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          Remove
        </button>
      </div>

      <div className="px-4">
        <div className="text-6xl md:text-7xl font-extrabold tracking-wider text-center drop-shadow">
          {formatHHMMSS(timer.remainingSec)}
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden mt-3">
          <div className={`h-full ${isLow ? "bg-red-400" : "bg-white"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        <button
          onClick={() => onUpdate(timer.id, { status: timer.status === "RUNNING" ? "PAUSED" : "RUNNING" })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          {timer.status === "RUNNING" ? "Pause" : "Start"}
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: timer.durationSec, status: "PAUSED" })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          Reset
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: Math.max(0, timer.remainingSec - 60) })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          -1 min
        </button>
        <button
          onClick={() => onUpdate(timer.id, { remainingSec: timer.remainingSec + 60 })}
          className="px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20"
        >
          +1 min
        </button>
        <div className="col-span-2 md:col-span-4 grid grid-cols-2 gap-2">
          <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
            Minutes
            <input
              type="number"
              min={1}
              className="w-20 text-black rounded-xl px-2 py-1"
              value={Math.round(timer.durationSec / 60)}
              onChange={(e) => {
                const mins = Math.max(1, Number(e.target.value) || 1)
                const durationSec = mins * 60
                const remainingSec = Math.min(timer.remainingSec, durationSec)
                onUpdate(timer.id, { durationSec, remainingSec })
              }}
            />
          </label>
          <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
            Announce at (min, comma‑sep)
            <input
              type="text"
              className="text-black rounded-xl px-2 py-1 w-full"
              value={timer.announceAt.map((s) => Math.floor(s / 60)).join(",")}
              onChange={(e) => {
                const mins = e.target.value
                  .split(",")
                  .map((x) => Number(x.trim()))
                  .filter((x) => !isNaN(x) && x >= 0)
                onUpdate(timer.id, { announceAt: mins.map((m) => m * 60) })
              }}
            />
          </label>
        </div>
      </div>
    </div>
  )
}

function AdminPanel({
  onAddTimer,
  setTickRateMs,
  voiceName,
  setVoiceName,
  onBackdropFile,
  clearBackdrop,
}: {
  onAddTimer: (preset?: { game?: string; icon?: string; minutes?: number }) => void
  setTickRateMs: (n: number) => void
  voiceName?: string
  setVoiceName: (v?: string) => void
  onBackdropFile: (f: File) => void
  clearBackdrop: () => void
}) {
  const [minutes, setMinutes] = useState(PRESETS[0]?.minutes || 50)
  const [game, setGame] = useState(PRESETS[0]?.label || "Untitled Game")
  const [icon, setIcon] = useState(PRESETS[0]?.icon || "🎮")
  const [customIconUrl, setCustomIconUrl] = useState("")
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.onvoiceschanged = load
  }, [])

  return (
    <div className="mt-4 p-4 rounded-3xl bg-black/30 border border-white/10">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((g) => (
              <button
                key={g.label}
                className={`px-3 py-2 rounded-2xl border ${game === g.label ? "bg-white/20 border-white/40" : "bg-white/10 border-white/20"}`}
                onClick={() => {
                  setGame(g.label)
                  setIcon(g.icon)
                  setMinutes(g.minutes)
                }}
              >
                <span className="mr-2">{g.icon}</span>
                {g.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Game
              <input
                className="text-black rounded-xl px-2 py-1 w-full"
                value={game}
                onChange={(e) => setGame(e.target.value)}
              />
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Minutes
              <input
                type="number"
                min={1}
                className="text-black rounded-xl px-2 py-1 w-full"
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Icon (emoji)
              <input
                className="text-black rounded-xl px-2 py-1 w-full"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              />
            </label>
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20 md:col-span-2">
              or Icon URL
              <input
                className="text-black rounded-xl px-2 py-1 w-full"
                placeholder="https://..."
                value={customIconUrl}
                onChange={(e) => setCustomIconUrl(e.target.value)}
              />
            </label>
            <button
              onClick={() => onAddTimer({ game, icon: customIconUrl || icon, minutes })}
              className="px-3 py-2 rounded-2xl bg-emerald-400/20 hover:bg-emerald-400/30 border border-emerald-300/40"
            >
              + Add Timer
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Tick rate (ms)
              <input
                type="number"
                min={250}
                step={250}
                className="text-black rounded-xl px-2 py-1 w-full"
                defaultValue={1000}
                onChange={(e) => setTickRateMs(Math.max(250, Number(e.target.value) || 1000))}
              />
            </label>

            <label className="text-sm flex items-center gap-2 bg-white/10 px-3 py-2 rounded-2xl border border-white/20">
              Voice
              <select
                className="text-black rounded-xl px-2 py-1 w-full"
                value={voiceName || ""}
                onChange={(e) => setVoiceName(e.target.value || undefined)}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm bg-white/10 px-3 py-2 rounded-2xl border border-white/20 cursor-pointer">
              <input
                type="file"
                className="hidden"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onBackdropFile(f)
                }}
              />
              Set background image…
            </label>
            <button onClick={clearBackdrop} className="text-sm px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20">
              Clear background
            </button>
          </div>

          <p className="text-xs opacity-80">
            Tip: Keep this page open on your display. You can toggle admin mode to prevent accidental edits.
          </p>
        </div>
      </div>
    </div>
  )
}
