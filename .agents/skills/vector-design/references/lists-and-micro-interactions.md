# Lists And Micro-Interactions

Use this reference for issue tables, management lists, member lists, and any row-based editable surface.

Canonical files:

- `src/components/issues/issues-table.tsx`
- `src/components/organization/members-list.tsx`
- `src/components/projects/project-members.tsx`
- `src/components/organization/role-selector.tsx`
- `src/components/organization/custom-roles-manager.tsx`

## Row Philosophy

A Vector row is both:

- a scanning surface
- an editing surface

The user should be able to understand the item and act on its most common properties without leaving the row.

## Core Row Anatomy

The row usually follows this structure:

1. Fixed utility slot
   Example: priority icon, avatar, leading state indicator
2. Identifiers
   Example: key, parent key, email metadata
3. Primary content
   Usually `min-w-0 flex-1`
4. Inline editable properties
   Team, project, role, assignees, assignment state
5. Secondary metadata
   Date, counts, badges
6. Overflow actions
   `DropdownMenu` on a ghost `h-6 w-6 p-0` button

Structural classes that repeat:

- row shell: `flex items-center gap-3 px-3 py-2`
- hover: `hover:bg-muted/50 transition-colors`
- fixed regions: `flex-shrink-0`
- main content: `min-w-0 flex-1`

## Motion

If rows are added, removed, or re-sorted:

```tsx
<AnimatePresence initial={false}>
  {rows.map(row => (
    <motion.div
      key={row.id}
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
    />
  ))}
</AnimatePresence>
```

Use motion to preserve spatial continuity, not to decorate the UI.

## Inline Controls

Use the control type that matches the action frequency:

- common field change: `Popover + Command`
- destructive or infrequent action: `DropdownMenu`
- add-member or add-assignee flow: compact dialog or popover

Do not hide high-frequency edits behind the overflow menu.

## Selector Placement

Common trigger strategies:

- `labelOnly` when the icon already exists elsewhere in the row
- `iconWhenUnselected` when width is tight
- icon-only for small dense triggers, usually with a tooltip if the meaning is not obvious

For issue rows specifically:

- priority uses a tiny custom trigger icon
- assignment state is inline and central
- team/project selectors sit after the title
- assignees are near the far edge

## Nested Micro-Actions

One of the stronger Vector patterns is nested action density inside command surfaces.

Example reference: the multi-assignment selector in `src/components/issues/issue-selectors.tsx`

That pattern allows:

- a searchable command list as the primary chooser
- nested `DropdownMenu` actions on specific items for less common operations

Use this pattern only when the user truly needs secondary actions on list items without leaving the current popover.

## Member And Role Rows

`members-list.tsx` and `project-members.tsx` are important because they show that dense rows are not only for issues:

- avatar at `size-6`
- name + muted metadata stacked in one compact column
- role and custom-role controls inline on the same row
- join date or supporting metadata on the right
- overflow menu only for destructive actions

This is the pattern to copy for admin/management lists.

## Highlighting Rules

Use subtle row highlighting only when it conveys meaningful state.

Example:

- `bg-accent/30` for rows that are especially relevant to the current user in the current filter context

Avoid colorful zebra striping or decorative status backgrounds.

## Loading And Empty States

For loading:

- use `Skeleton`
- match the eventual row layout
- avoid `Loading...` text for row collections

If a list surface needs a compact indeterminate loader outside the row skeleton state, use `BarsSpinner` from `src/components/bars-spinner.tsx` as the default spinner.

For empty states:

- keep them simple
- use them only when there is truly no operational content to show

If an empty or transitional centered state includes one short line explaining a useful capability, shortcut, or interesting system behavior, `GradientWaveText` from `src/components/gradient-wave-text.tsx` is the default emphasis treatment for that small supporting text.

Operational screens should default to rows, not giant empty-state illustrations.

## Row Checklist

- Can the user scan the row in one horizontal pass?
- Is the title/content block the flexible area?
- Are frequent edits inline?
- Are rare actions pushed into overflow?
- Are controls aligned to the established `h-6`/`h-8` sizes?
- If the row mutates or reorders, does motion preserve continuity?
