# Optimistic Updates in Vector

Vector currently implements most micro-interaction optimism with a local overlay hook in `src/hooks/use-optimistic.ts`.

That is important: in this codebase, "optimistic updates" usually means "the selector trigger shows the new value immediately while Convex catches up", not "the app is mutating Convex local store caches with `withOptimisticUpdate` everywhere".

For single-field inline pickers, this local overlay pattern is the default.

## How The Local Overlay Works

1. User picks a new value in a selector (e.g. changes priority)
2. `setOptimistic(newValue)` is called **before** the mutation fires
3. The selector immediately displays `newValue`
4. The Convex mutation runs server-side
5. Convex's reactive subscription updates the query data
6. The parent re-renders with the new server value
7. React's "adjust state during render" pattern detects the server change and clears the optimistic override
8. A safety timeout (5s) clears stale optimistic state if the mutation fails

## Hook API

```tsx
import { useOptimisticValue } from '@/hooks/use-optimistic';

// Single value (string, number, etc.)
const [displayValue, setOptimistic] = useOptimisticValue(serverValue);

// Array variant (compares by JSON serialisation)
import { useOptimisticArray } from '@/hooks/use-optimistic';
const [displayItems, setOptimisticItems] = useOptimisticArray(serverItems);
```

## Usage in Selectors

Every selector follows this pattern:

```tsx
export function XSelector({ selectedX, onXSelect, ... }) {
  const [displayX, setOptimisticX] = useOptimisticValue(selectedX);

  // Use displayX for ALL display logic (finding current item, check marks, button label)
  const current = items.find(i => i._id === displayX);

  // On select: set optimistic FIRST, then fire the callback
  const handleSelect = (id: string) => {
    setOptimisticX(id);     // instant UI update
    onXSelect(id);          // fires mutation in parent
    setOpen(false);
  };

  // Check marks use displayX
  <Check className={cn('mr-2 h-4 w-4',
    displayX === item._id ? 'opacity-100' : 'opacity-0'
  )} />
}
```

## Selectors With Optimistic Updates

All of these selectors use `useOptimisticValue` internally:

| Selector            | File                      | Optimistic field   |
| ------------------- | ------------------------- | ------------------ |
| PrioritySelector    | issue-selectors.tsx       | `selectedPriority` |
| StateSelector       | issue-selectors.tsx       | `selectedState`    |
| ProjectSelector     | issue-selectors.tsx       | `selectedProject`  |
| TeamSelector        | team-selector.tsx         | `selectedTeam`     |
| VisibilitySelector  | visibility-selector.tsx   | `value`            |
| StatusSelector      | project-selectors.tsx     | `selectedStatus`   |
| ProjectLeadSelector | project-lead-selector.tsx | `selectedLead`     |
| RoleSelector        | role-selector.tsx         | `currentRole`      |

## Parent Components

Parents usually continue to fire mutations normally. The optimistic behavior is encapsulated inside the selector:

```tsx
// Parent: no change needed
const handlePriorityChange = (issueId: string, priorityId: string) => {
  void changePriorityMutation({
    issueId: issueId as Id<'issues'>,
    priorityId: priorityId as Id<'issuePriorities'>,
  });
};

<PrioritySelector
  priorities={priorities}
  selectedPriority={issue.priorityId || ''}
  onPrioritySelect={id => handlePriorityChange(issue._id, id)}
/>;
```

## When To Use `useOptimisticArray`

Use `useOptimisticArray` when the trigger displays a short array-shaped projection of server data and the interaction should feel instant in one component.

Examples:

- a small avatar stack
- selected chips on a trigger
- inline multi-select summaries

Do not use it as a replacement for proper cache updates when multiple query subscribers need to stay in sync immediately.

## When To Consider Real Convex Optimistic Updates

If the mutation changes shared list structure, count, ordering, or membership across several subscribers, the local overlay hook is often too narrow.

That is when to consider Convex `withOptimisticUpdate` on the mutation itself.

Examples:

- inserting or removing rows from a visible list
- moving an item between filtered groups where multiple views depend on the same query
- updating counts or aggregates that must reflect instantly across the screen

If you need that level of optimism, also read the `convex-realtime` skill.

## When NOT To Use The Local Overlay Pattern

- **Creation dialogs** — local form state already provides instant feedback
- **Delete operations** — should wait for confirmation + mutation
- **Multi-step operations** — e.g. file uploads, where progress is shown differently
- **Navigation triggers** — e.g. slug changes that cause a redirect
- **Broad query reshaping** — prefer a real Convex optimistic update instead of a trigger-only overlay
