export const SETTINGS_SHEET_CLASSNAMES = {
  panel:
    'bottom-0 left-0 top-0 h-full w-[min(1040px,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none rounded-r-2xl border-r border-border/70 bg-popover/96 p-0 shadow-2xl data-open:slide-in-from-left-6 data-open:zoom-in-100 data-closed:slide-out-to-left-6 data-closed:zoom-out-100',
  frame: 'grid h-full min-h-0 grid-cols-[264px_minmax(0,1fr)] overflow-hidden',
  sidebar: 'flex min-h-0 flex-col border-r border-border/60 bg-muted/12 px-5 py-5',
  contentShell: 'flex min-h-0 flex-col bg-popover/88',
  contentScroll: 'min-h-0 flex-1 overflow-y-auto px-8 py-6',
} as const
