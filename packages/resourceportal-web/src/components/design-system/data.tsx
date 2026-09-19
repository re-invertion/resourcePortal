import type { ReactNode } from "react";
import { Card, EmptyState, LoadingState, cx } from "./primitives";

export function DataTable({
  columns,
  rows,
  loading,
  empty,
  footer,
  className,
  embedded = false,
}: {
  columns: Array<{ key: string; label: ReactNode; className?: string }>;
  rows: Array<{ key: string; cells: Record<string, ReactNode>; href?: string }>;
  loading?: boolean;
  empty?: ReactNode;
  footer?: ReactNode;
  className?: string;
  embedded?: boolean;
}) {
  const content = <>
    {loading
      ? <LoadingState rows={5}/>
      : rows.length === 0
        ? (empty ?? <EmptyState title="No results" />)
        : <div className="max-w-full min-w-0 overflow-x-auto overscroll-x-contain [contain:layout_paint]">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="bg-[#EEF2F7]"><tr>{columns.map(col => <th key={col.key} className={cx("h-10 border-0 px-4 text-[12px] font-semibold text-[#526070]", col.className)}>{col.label}</th>)}</tr></thead>
              <tbody className="divide-y divide-[#E1E7F0]">{rows.map(row => <tr key={row.key} className="group h-[54px] bg-white hover:bg-[#F8FAFD]">{columns.map((col, index) => <td key={col.key} className={cx("space-x-0 border-0 px-4 py-2.5 text-[13px] text-[#344054]", col.className)}>{row.href && index === 0 ? <a href={row.href} className="block font-medium text-[#172033] group-hover:text-[#135FBB]">{row.cells[col.key]}</a> : row.cells[col.key]}</td>)}</tr>)}</tbody>
            </table>
          </div>}
    {footer ? <div className="border-t border-[#E1E7F0] bg-white px-4 py-3 text-xs text-[#718096]">{footer}</div> : null}
  </>;

  if (embedded) {
    return <div className={cx("min-w-0 overflow-hidden bg-white", className)}>{content}</div>;
  }

  return <Card className={cx("overflow-hidden", className)}>{content}</Card>;
}

export function Toolbar({ search, filters, meta, actions }: { search?: ReactNode; filters?: ReactNode; meta?: ReactNode; actions?: ReactNode }) { return <div className="flex flex-col gap-3 border-b border-[#E1E7F0] bg-white px-4 py-3 lg:flex-row lg:items-center"><div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">{search}{filters}</div>{meta ? <div className="min-w-0 break-words text-xs text-[#5B6678]">{meta}</div> : null}{actions ? <div className="flex max-w-full flex-wrap gap-2">{actions}</div> : null}</div>; }

export function DetailList({ items, columns = 2 }: { items: Array<{ label: ReactNode; value: ReactNode }>; columns?: 1 | 2 | 3 }) { return <dl className={cx("grid gap-x-8 gap-y-5", columns === 1 ? "grid-cols-1" : columns === 3 ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}>{items.map((item, i) => <div key={i} className="min-w-0"><dt className="text-[12px] font-medium text-[#718096]">{item.label}</dt><dd className="mt-1 break-words text-sm text-[#172033]">{item.value}</dd></div>)}</dl>; }

export function KeyValueRows({ rows }: { rows: Array<{ label: ReactNode; value: ReactNode; href?: string }> }) { return <div className="divide-y divide-[#E1E7F0]">{rows.map((row, index) => <div key={index} className="flex min-h-10 items-center justify-between gap-4 py-2.5 text-[13px]"><span className="text-[#172033]">{row.label}</span>{row.href ? <a href={row.href} className="font-medium text-[#0F56A7] hover:underline">{row.value}</a> : <span className="text-right text-[#42526B]">{row.value}</span>}</div>)}</div>; }

export function ResourceMark({ children, className }: { children: ReactNode; className?: string }) { return <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F0F5FC] text-[#1769E0]", className)}>{children}</span>; }
