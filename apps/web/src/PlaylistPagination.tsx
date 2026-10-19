import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type FormEvent, useState } from 'react'

export function playlistOffsetForPage(
  rawPage: string,
  total: number,
  pageSize: number,
): number | null {
  const value = rawPage.trim()
  const page = Number(value)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > pageCount
  )
    return null
  return (page - 1) * pageSize
}

export function PlaylistPagination({
  offset,
  total,
  pageSize,
  busy,
  onOffsetChange,
}: {
  offset: number
  total: number
  pageSize: number
  busy: boolean
  onOffsetChange: (offset: number) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.floor(offset / pageSize) + 1, pageCount)
  const scope = `${offset}:${total}:${pageSize}`
  const [draft, setDraft] = useState({ scope: '', value: '', invalid: false })
  const pageInput = draft.scope === scope ? draft.value : String(currentPage)
  const invalid = draft.scope === scope && draft.invalid

  const changeOffset = (nextOffset: number) => {
    if (busy) return
    setDraft({ scope: '', value: '', invalid: false })
    onOffsetChange(nextOffset)
  }
  const jumpToPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const nextOffset = playlistOffsetForPage(pageInput, total, pageSize)
    if (nextOffset === null) {
      setDraft({ scope, value: pageInput, invalid: true })
      return
    }
    changeOffset(nextOffset)
  }

  return (
    <nav className="playlist-pagination" aria-label="歌曲分页">
      <span aria-live="polite">
        第 {currentPage} / {pageCount} 页 · 共 {total} 首
      </span>
      <div className="playlist-page-controls">
        <button
          className="text-button"
          type="button"
          disabled={currentPage === 1 || busy}
          onClick={() => changeOffset(0)}
        >
          首页
        </button>
        <button
          className="text-button"
          type="button"
          disabled={currentPage === 1 || busy}
          onClick={() => changeOffset(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft aria-hidden="true" size={16} />
          上一页
        </button>
        <button
          className="text-button"
          type="button"
          disabled={currentPage >= pageCount || busy}
          onClick={() => changeOffset(offset + pageSize)}
        >
          下一页
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        <button
          className="text-button"
          type="button"
          disabled={currentPage >= pageCount || busy}
          onClick={() => changeOffset((pageCount - 1) * pageSize)}
        >
          末页
        </button>
      </div>
      <form className="playlist-page-jump" onSubmit={jumpToPage} noValidate>
        <label>
          <span>跳至</span>
          <input
            aria-label="跳转页码"
            aria-invalid={invalid}
            aria-describedby={invalid ? 'playlist-page-error' : undefined}
            inputMode="numeric"
            maxLength={16}
            value={pageInput}
            readOnly={busy}
            aria-disabled={busy}
            onChange={(event) =>
              setDraft({ scope, value: event.target.value, invalid: false })
            }
          />
          <span>页</span>
        </label>
        <button className="text-button" type="submit" disabled={busy}>
          跳转
        </button>
      </form>
      {invalid && (
        <p
          className="notice error playlist-page-error"
          id="playlist-page-error"
          role="alert"
        >
          请输入 1–{pageCount} 之间的整数页码。
        </p>
      )}
    </nav>
  )
}
