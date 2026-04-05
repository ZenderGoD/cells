export const SETTINGS_SHEET_CLASSNAMES = {
  /** Kept for test compat — not rendered when sidebar is inlined */
  sidebarPanel:
    'fixed inset-y-6 left-6 z-[20001] flex w-[200px] flex-col rounded-xl border border-border/40 bg-popover px-3 py-3.5 shadow-2xl',
  contentPanel:
    'fixed top-1/2 left-1/2 z-[20001] flex w-[min(680px,calc(100vw-4rem))] max-w-[720px] min-w-[600px] max-h-[min(540px,calc(100vh-6rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/8 outline-none shadow-2xl',
  contentHeader: 'border-b border-border/30 px-4 py-2',
  contentScroll: 'flex-1 min-h-0 overflow-y-auto',
} as const
