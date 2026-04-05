import ClaudeCode from '@lobehub/icons/es/ClaudeCode'
import OpenAI from '@lobehub/icons/es/OpenAI'
import { Bot, Sparkles } from 'lucide-react'

import { getAgentBrand, type AgentName } from '@/lib/agent-brand'
import { cn } from '@/lib/utils'

interface AgentIconProps {
  agent: AgentName
  className?: string
  size?: number | string
}

export function AgentIcon({ agent, className, size = 14 }: AgentIconProps) {
  const brand = getAgentBrand(agent)
  const numericSize = typeof size === 'number' ? size : Number.parseFloat(size) || 14

  if (brand === 'claude-code') {
    return <ClaudeCode.Color className={cn('shrink-0', className)} size={size} />
  }

  if (brand === 'openai') {
    return <OpenAI.Avatar className={cn('shrink-0', className)} size={numericSize} />
  }

  if (brand === 'opencode') {
    return <Bot className={cn('shrink-0', className)} style={{ width: size, height: size }} />
  }

  if (brand === 'pi') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full border border-current/15 bg-current/8 font-semibold leading-none',
          className,
        )}
        style={{
          width: numericSize,
          height: numericSize,
          fontSize: Math.max(9, numericSize * 0.75),
        }}
        aria-label="Pi"
      >
        π
      </span>
    )
  }

  return <Sparkles className={cn('shrink-0', className)} style={{ width: size, height: size }} />
}
