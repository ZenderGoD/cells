export interface StableListState<T> {
  byId: Map<string, T>
  result: T[]
}

export function createEmptyStableListState<T>(): StableListState<T> {
  return {
    byId: new Map<string, T>(),
    result: [],
  }
}

export function computeStableList<T>(
  items: readonly T[],
  previous: StableListState<T>,
  options: {
    getId: (item: T) => string
    isUnchanged: (previous: T, next: T) => boolean
  },
): StableListState<T> {
  const nextById = new Map<string, T>()
  let anyChanged = items.length !== previous.byId.size

  const result = items.map((item, index) => {
    const id = options.getId(item)
    const previousItem = previous.byId.get(id)
    const nextItem = previousItem && options.isUnchanged(previousItem, item) ? previousItem : item
    nextById.set(id, nextItem)
    if (!anyChanged && previous.result[index] !== nextItem) {
      anyChanged = true
    }
    return nextItem
  })

  return anyChanged ? { byId: nextById, result } : previous
}
