import { cloneElement, createContext, isValidElement, memo, useContext, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useReducedMotion } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { activateLink } from '@/lib/activate-link'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/packages/ui/src/components/markdown/Markdown.tsx
// We mirror the `minimal` render mode — the one Craft uses inside chat turn
// responses — without the full-mode block renderers (diff, mermaid, pdf,
// datatable, etc). Typography, spacing, and heading sizes match exactly.

interface AgentMarkdownProps {
  children: string
  className?: string
  /** Inline mode collapses block spacing for short messages. */
  inline?: boolean
  /** Treat single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean
  /** Reveal the trailing text while a response streams. */
  streamingReveal?: boolean
  /** Route image clicks into a caller-owned preview surface. */
  onImageClick?: (src: string) => void
}

const STREAMING_REVEAL_WORDS = 9
const MarkdownSourceContext = createContext('')

function splitTrailingWords(text: string) {
  const matches = Array.from(text.matchAll(/\S+\s*/g))
  if (matches.length === 0) return null
  const firstReveal = matches[Math.max(0, matches.length - STREAMING_REVEAL_WORDS)]
  const start = firstReveal.index ?? 0
  return {
    stable: text.slice(0, start),
    reveal: text.slice(start),
    revealStart: start,
  }
}

function StreamingRevealTail({ text, startOffset }: { text: string; startOffset: number }) {
  const segments = text.match(/\S+|\s+/g) ?? [text]
  const characterCount = segments.reduce((count, segment) => {
    if (/^\s+$/.test(segment)) return count
    return count + Array.from(segment).length
  }, 0)
  let characterIndex = 0
  let textOffset = 0
  const renderedParts: React.ReactNode[] = []

  for (const segment of segments) {
    if (/^\s+$/.test(segment)) {
      renderedParts.push(segment)
      textOffset += segment.length
      continue
    }

    for (const character of Array.from(segment)) {
      const ratio = characterCount <= 1 ? 1 : characterIndex / (characterCount - 1)
      const key = startOffset + textOffset
      characterIndex += 1
      textOffset += character.length
      renderedParts.push(
        <span
          key={key}
          className="streaming-reveal-character"
          style={{ '--streaming-reveal-ratio': ratio } as CSSProperties}
        >
          {character}
        </span>,
      )
    }
  }

  return <span className="streaming-reveal-tail whitespace-pre-wrap">{renderedParts}</span>
}

function revealTrailingText(children: React.ReactNode): React.ReactNode {
  const state = { revealed: false }

  function visit(node: React.ReactNode): React.ReactNode {
    if (state.revealed || node == null || typeof node === 'boolean') return node
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node)
      const split = splitTrailingWords(text)
      if (!split) return node
      state.revealed = true
      return (
        <>
          {split.stable}
          <StreamingRevealTail text={split.reveal} startOffset={split.revealStart} />
        </>
      )
    }
    if (Array.isArray(node)) {
      const next = [...node]
      for (let index = next.length - 1; index >= 0; index -= 1) {
        next[index] = visit(next[index])
        if (state.revealed) break
      }
      return next
    }
    if (isValidElement<{ children?: React.ReactNode }>(node) && node.props.children) {
      return cloneElement(node, undefined, visit(node.props.children))
    }
    return node
  }

  return visit(children)
}

function isTailMarkdownNode(node: any, source: string): boolean {
  const endOffset = node?.position?.end?.offset
  if (typeof endOffset !== 'number') return false
  return endOffset >= source.trimEnd().length
}

function maybeRevealTail(children: React.ReactNode, enabled: boolean) {
  return enabled ? revealTrailingText(children) : children
}

function RevealableMarkdownNode({
  children,
  enabled,
  node,
}: {
  children: React.ReactNode
  enabled: boolean
  node: any
}) {
  const source = useContext(MarkdownSourceContext)
  return <>{maybeRevealTail(children, enabled && isTailMarkdownNode(node, source))}</>
}

function createComponents(
  streamingReveal: boolean,
  reduceMotion: boolean,
  onImageClick?: (src: string) => void,
) {
  const canReveal = streamingReveal && !reduceMotion
  return {
    a: ({ href, children, ...props }: any) => (
      <a
        {...props}
        href={href}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
          // Route through the same activation logic as terminal links so
          // linkRules / terminalLinkTarget / directoryLinkTarget are honored.
          if (!href) return
          // Let modifier-click fall through to the default handler.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          activateLink(href)
        }}
        target="_blank"
        rel="noreferrer noopener"
        className="text-foreground underline underline-offset-2 decoration-foreground/35 hover:decoration-foreground"
      >
        {children}
      </a>
    ),
    img: ({ src, alt, ...props }: any) => {
      const image = (
        <img
          {...props}
          src={src}
          alt={alt ?? ''}
          className="my-1 max-h-72 max-w-full rounded-[8px] border border-border/35 object-contain"
        />
      )
      if (!src || !onImageClick) return image
      return (
        <button
          type="button"
          onClick={() => onImageClick(String(src))}
          className="block rounded-[8px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
          title={alt || String(src)}
        >
          {image}
        </button>
      )
    },
    // Inline code: subtle background, slightly smaller, monospace. Block code
    // gets wrapped by `pre` below. Craft's InlineCode uses the same rounded
    // muted-bg pattern.
    code: ({ inline: isInline, className, children, ...props }: any) => {
      const match = /language-([\w-]+)/.exec(className || '')
      const isBlock =
        !isInline &&
        ('node' in props && props.node?.position
          ? props.node.position.start.line !== props.node.position.end.line
          : !!match)
      if (isBlock) {
        return (
          <code className={cn('font-mono text-[12.5px]', className)} {...props}>
            {children}
          </code>
        )
      }
      return (
        <code
          className="rounded-[4px] bg-foreground/10 px-1 py-[1px] font-mono text-[0.92em]"
          {...props}
        >
          {children}
        </code>
      )
    },
    pre: ({ children, ...props }: any) => (
      <pre
        {...props}
        className="my-2 overflow-x-auto rounded-[10px] border border-border/60 bg-background/70 p-3 text-[12.5px] leading-[1.55] font-mono"
      >
        {children}
      </pre>
    ),
    // Lists: Craft uses `my-2 space-y-1 ps-[16px] pe-2 list-disc` for ul and
    // `my-2 space-y-1 pl-6 list-decimal` for ol. Task lists drop the marker.
    ul: ({ className, ...props }: any) => (
      <ul
        {...props}
        className={cn(
          'my-2 space-y-1 ps-[16px] pe-2 list-disc marker:text-foreground/35',
          className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
        )}
      />
    ),
    ol: ({ className, ...props }: any) => (
      <ol {...props} className={cn('my-2 space-y-1 pl-6 list-decimal', className)} />
    ),
    li: ({ children, className, node, ...props }: any) => (
      <li
        {...props}
        className={cn('leading-relaxed', className?.includes('task-list-item') && 'list-none')}
      >
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </li>
    ),
    input: ({ type, checked, ...rest }: any) => {
      if (type === 'checkbox') {
        return (
          <input
            {...rest}
            type="checkbox"
            checked={!!checked}
            readOnly
            className="mr-2 rounded border-muted-foreground align-middle"
          />
        )
      }
      return <input type={type} {...rest} />
    },
    // Paragraph: my-2 leading-relaxed (Craft minimal mode).
    p: ({ children, node, ...props }: any) => (
      <p {...props} className="my-2 leading-relaxed">
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </p>
    ),
    // Headings: H1/H2 both 16px, differentiated by weight; H3 is 15px.
    h1: ({ children, node, ...props }: any) => (
      <h1 {...props} className="font-sans text-[16px] font-bold mt-5 mb-3">
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </h1>
    ),
    h2: ({ children, node, ...props }: any) => (
      <h2 {...props} className="font-sans text-[16px] font-semibold mt-4 mb-3">
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </h2>
    ),
    h3: ({ children, node, ...props }: any) => (
      <h3 {...props} className="font-sans text-[15px] font-semibold mt-4 mb-2">
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </h3>
    ),
    h4: ({ children, node, ...props }: any) => (
      <h4 {...props} className="font-sans text-[14px] font-semibold mt-3 mb-2">
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </h4>
    ),
    blockquote: ({ children, node, ...props }: any) => (
      <blockquote
        {...props}
        className="my-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground italic"
      >
        <RevealableMarkdownNode enabled={canReveal} node={node}>
          {children}
        </RevealableMarkdownNode>
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-border" />,
    strong: (props: any) => <strong {...props} className="font-semibold" />,
    em: (props: any) => <em {...props} className="italic" />,
    // Tables
    table: ({ children }: any) => (
      <div className="my-3 overflow-x-auto">
        <table className="min-w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }: any) => <thead className="border-b border-border/60">{children}</thead>,
    th: ({ children }: any) => (
      <th className="text-left py-2 px-3 font-semibold text-muted-foreground">{children}</th>
    ),
    td: ({ children }: any) => <td className="py-2 px-3 border-b border-border/40">{children}</td>,
  }
}

export const AgentMarkdown = memo(function AgentMarkdown({
  children,
  className,
  inline,
  breaks,
  streamingReveal,
  onImageClick,
}: AgentMarkdownProps) {
  // No font-size / color override here — the response card wrapper sets
  // `text-sm` and the default foreground color, matching Craft's ResponseCard.
  // Overriding here would disagree with Craft.
  const reduceMotion = useReducedMotion()
  const plugins = useMemo(() => (breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]), [breaks])
  const components = useMemo(
    () => createComponents(!!streamingReveal, !!reduceMotion, onImageClick),
    [onImageClick, reduceMotion, streamingReveal],
  )
  return (
    <div className={cn('agent-markdown', inline && '[&_p]:m-0 [&_p]:inline', className)}>
      <MarkdownSourceContext.Provider value={children}>
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {children}
        </ReactMarkdown>
      </MarkdownSourceContext.Provider>
    </div>
  )
})
