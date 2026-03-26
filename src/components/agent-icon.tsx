import ClaudeCode from '@lobehub/icons/es/ClaudeCode'
import Codex from '@lobehub/icons/es/Codex'
import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'

type AgentName = 'claude' | 'codex' | null | undefined

interface AgentIconProps {
  agent: AgentName
  className?: string
  size?: number | string
}

export function AgentIcon({ agent, className, size = 14 }: AgentIconProps) {
  if (agent === 'claude') {
    return <ClaudeCode.Color className={cn('shrink-0', className)} size={size} />
  }

  if (agent === 'codex') {
    return <Codex.Color className={cn('shrink-0', className)} size={size} />
  }

  return <Sparkles className={cn('shrink-0', className)} style={{ width: size, height: size }} />
}
