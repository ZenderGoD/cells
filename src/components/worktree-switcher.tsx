import { WorktreeManager } from '@/components/worktree-manager'

interface WorktreeSwitcherProps {
  termId: string
  className?: string
}

export function WorktreeSwitcher({ termId, className }: WorktreeSwitcherProps) {
  return <WorktreeManager terminalId={termId} compact className={className} />
}
