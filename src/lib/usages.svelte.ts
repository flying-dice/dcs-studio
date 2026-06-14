// Find-usages results store (model studio::edit Refactoring.PublishUsages):
// the Usages panel reads from here, like the Problems panel reads its findings.
// One symbol's references at a time — a fresh query replaces the last.

/** One usage row: a navigable offset plus a rendered line preview. */
export interface UsageItem {
  path: string;
  /** Document offset of the occurrence — go-to navigation lands here. */
  offset: number;
  /** 1-based line / column for display. */
  line: number;
  col: number;
  /** The occurrence's source line, trimmed, for the row preview. */
  preview: string;
}

class UsagesStore {
  /** The symbol whose uses are listed (panel header); null = never queried. */
  symbol = $state<string | null>(null);
  /** Every occurrence, declaration included, ordered by file then offset. */
  items = $state<UsageItem[]>([]);

  /** Publish a fresh result set; an empty list shows the panel's empty state. */
  set(symbol: string, items: UsageItem[]): void {
    this.symbol = symbol;
    this.items = items;
  }

  clear(): void {
    this.symbol = null;
    this.items = [];
  }
}

export const usages = new UsagesStore();
