export const SETTINGS_SHEET_CLASSNAMES = {
  sidebarPanel:
    'fixed inset-y-6 left-6 z-50 flex w-[240px] flex-col rounded-2xl border border-border/70 bg-popover/94 px-4 py-4 shadow-2xl',
  contentPanel:
    'fixed top-1/2 left-1/2 z-50 grid w-[min(960px,calc(100vw-22rem))] max-w-[960px] min-w-[680px] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover/96 p-0 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none',
  contentHeader: 'border-b border-border/60 px-8 py-6',
  contentScroll: 'max-h-[min(720px,calc(100vh-8rem))] overflow-y-auto px-8 py-6',
} as const
