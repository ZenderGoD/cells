# Creation Dialogs

Use this reference when building a new create or quick-edit dialog in Vector.

Canonical files:

- `src/components/issues/create-issue-dialog.tsx`
- `src/components/projects/create-project-dialog.tsx`
- `src/components/teams/create-team-dialog.tsx`
- `src/components/organization/states-management-dialog.tsx`

## Dialog Philosophy

Vector dialogs are compact editing workspaces, not marketing modals.

They should feel like:

- a fast keyboard-first creation surface
- directly connected to the table or page the user came from
- dense enough to keep all major fields visible without scrolling

They should not feel like:

- wizard flows
- card stacks inside a modal
- large vertically padded forms

## Standard Structure

Most dialogs follow this shell:

```tsx
<Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
  <DialogHeader className='sr-only'>
    <DialogTitle>Create item</DialogTitle>
  </DialogHeader>
  <DialogContent showCloseButton={false} className='gap-2 p-2 sm:max-w-2xl'>
    <form className='space-y-2'>
      {/* compact top row */}
      {/* key field or secondary field */}
      {/* description / body */}
    </form>

    <div className='flex w-full flex-row items-center justify-between gap-2'>
      <Button variant='ghost' size='sm' onClick={onClose}>
        Cancel
      </Button>
      <Button size='sm'>Create</Button>
    </div>
  </DialogContent>
</Dialog>
```

Defaults that matter:

- `DialogTitle` exists, often visually hidden
- `showCloseButton={false}`
- `gap-2 p-2`
- footer actions are explicit and compact

## Top Row Pattern

The top row usually combines the primary text input with inline selectors:

- primary field gets the most width
- secondary selectors sit to the right
- selectors use `displayMode='iconWhenUnselected'` when space is tight

Examples:

- issue create: team, assignee, state, priority, visibility
- project create: team, lead, status, visibility
- team create: lead, visibility

If a selector is icon-only and not fully self-explanatory, wrap it in a tooltip.

## Overlay Labels

Vector often uses internal overlay labels instead of stacked external labels:

```tsx
<div className='relative'>
  <Input className='pr-20 text-base' />
  <span className='text-muted-foreground bg-background pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded px-2 py-0.5 text-xs'>
    Name
  </span>
</div>
```

For textareas:

```tsx
<div className='relative'>
  <Textarea className='min-h-[120px] resize-none pr-20' />
  <span className='text-muted-foreground bg-background pointer-events-none absolute right-2 bottom-2 rounded px-2 py-0.5 text-xs'>
    Description
  </span>
</div>
```

Use this pattern when:

- the dialog is dense
- the placeholder can stay task-oriented
- the field meaning is stable and short

Avoid it for long explanatory forms or settings pages that already use explicit labels.

## Key Generation and Preview

When entities have short keys or slugs:

- auto-generate from the name when that improves speed
- keep manual override possible
- show the generated result inline, not in a separate helper block

Issue creation also uses a denser key preview row with a code-style preview and a dropdown for format overrides. That is a good reference when the identifier format itself is an editable concern.

## Loading and Submission

Creation dialogs already own local form state. That means:

- text inputs do not need optimistic overlays
- selector components may still have their own optimistic display logic
- submit buttons may show `Creating...` and disable while the request is in flight

Do not add page-level spinners inside the dialog for routine submission.
If a dialog needs an indeterminate spinner for a blocking async step, use `BarsSpinner` from `src/components/bars-spinner.tsx` as the default spinner component.

## Tone and Copy

Keep dialog copy short:

- placeholders are verbs or direct object labels
- button labels are action-first: `Create team`, `Create project`
- secondary text is rare and terse

If a dialog has a centered line of small supporting copy that calls attention to a useful capability or reassuring system behavior, prefer `GradientWaveText` from `src/components/gradient-wave-text.tsx` over plain muted text.
Keep it short, centered, and clearly secondary to the form.

## Dialog Checklist

- Is the title present for accessibility?
- Is the content using `gap-2 p-2` or similarly dense spacing?
- Does the primary input dominate the first row?
- Are inline selectors aligned to the existing `h-8`/`h-9` rhythm?
- Are labels either overlay-style or intentionally explicit, not mixed randomly?
- Is submit feedback minimal and direct?
