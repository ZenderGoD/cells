import { useStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { X } from 'lucide-react'

const SHORTCUTS = [
  {
    title: 'Open anything',
    shortcut: (
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>T</Kbd>
      </KbdGroup>
    ),
    description: 'Command palette - open files, create editors, terminals, and browsers.',
  },
  {
    title: 'See all terminals at once',
    shortcut: (
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>O</Kbd>
      </KbdGroup>
    ),
    description: 'Overview mode. Press ESC to return to focused terminal.',
  },
  {
    title: 'Navigate directionally',
    shortcut: (
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>H/J/K/L</Kbd>
      </KbdGroup>
    ),
    description: 'Move between terminals - vim-style navigation (left/down/up/right)',
  },
  {
    title: 'Cycle through terminals',
    shortcut: (
      <KbdGroup>
        <Kbd>⌃</Kbd>
        <Kbd>Tab</Kbd>
      </KbdGroup>
    ),
    description: 'Switcher overlay. Shift+Ctrl+Tab goes backwards.',
  },
  {
    title: 'Jump between projects',
    shortcut: (
      <KbdGroup>
        <Kbd>⌃</Kbd>
        <Kbd>`</Kbd>
      </KbdGroup>
    ),
    description: 'Cycle through open projects',
  },
]

export function OnboardingGuide() {
  const { showOnboardingGuide, dismissOnboardingGuide } = useStore(
    useShallow((s) => ({
      showOnboardingGuide: s.showOnboardingGuide,
      dismissOnboardingGuide: s.dismissOnboardingGuide,
    })),
  )

  if (!showOnboardingGuide) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      dismissOnboardingGuide()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <ScrollArea
        className="bg-card ring-1 ring-foreground/10 rounded-2xl max-w-2xl w-full mx-4 max-h-[85vh]"
        maskHeight={16}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border/20 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Keyboard shortcuts</h2>
          <button
            onClick={dismissOnboardingGuide}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          <div>
            <h3 className="text-sm text-muted-foreground mb-4">One terminal at a time</h3>
            <p className="text-sm text-muted-foreground">
              Cells focuses on one terminal. Navigate between them instead of managing them
              visually. Keep your hands on the keyboard.
            </p>
          </div>

          <div className="space-y-4">
            {SHORTCUTS.map((item) => (
              <div key={item.title} className="flex gap-4 items-start">
                <div className="flex gap-1 flex-wrap min-w-fit">{item.shortcut}</div>
                <div className="flex-1">
                  <div className="font-medium text-sm text-foreground">{item.title}</div>
                  <div className="text-xs text-muted-foreground mt-1">{item.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border/20 px-6 py-4 bg-muted/30 flex justify-end">
          <Button onClick={dismissOnboardingGuide}>Got it</Button>
        </div>
      </ScrollArea>
    </div>
  )
}
