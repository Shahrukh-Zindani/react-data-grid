import { useState, useRef, useLayoutEffect, useCallback } from 'react';
import { focusSinkClassname } from './style';
import { useLatestFunc, useColumns, useViewport } from './hooks';
import Row from './Row';
import GroupRowRenderer from './GroupRow';
import {
  assertIsValidKeyGetter,
  onEditorNavigation,
  getNextSelectedCellPosition,
  isSelectedCellEditable,
  canExitGrid,
  isCtrlKeyHeldDown,
  isDefaultCellInput
} from './utils';

import type {
  CalculatedColumn,
  Position,
  RowRendererProps,
  RowsChangeData,
  SelectRowEvent,
  SelectedCellProps,
  EditCellProps,
  FillEvent,
  PasteEvent,
  CellNavigationMode
} from './types';

interface SelectCellState extends Position {
  mode: 'SELECT';
}

interface EditCellState<R> extends Position {
  mode: 'EDIT';
  row: R;
  originalRow: R;
  key: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
const body = globalThis.document?.body;

export const DEFAULT_ROW_HEIGHT = 35;

export interface ViewportProps<R, SR = unknown> {
  /** A function called for each rendered row that should return a plain key/value pair object */
  rows: readonly R[];
  /** The getter should return a unique key for each row */
  rowKeyGetter?: (row: R) => React.Key;
  onRowsChange?: (rows: R[], data: RowsChangeData<R, SR>) => void;

  /** The height of each row in pixels */
  rowHeight?: number;

  /** Set of selected row keys */
  selectedRows?: ReadonlySet<React.Key>;
  /** Function called whenever row selection is changed */
  onSelectedRowsChange?: (selectedRows: Set<React.Key>) => void;
  groupBy?: readonly string[];
  rowGrouper?: (rows: readonly R[], columnKey: string) => Record<string, readonly R[]>;
  expandedGroupIds?: ReadonlySet<unknown>;
  onExpandedGroupIdsChange?: (expandedGroupIds: Set<unknown>) => void;
  onFill?: (event: FillEvent<R>) => R[];
  onPaste?: (event: PasteEvent<R>) => R;

  rowRenderer?: React.ComponentType<RowRendererProps<R, SR>>;

  /** Function called whenever a row is clicked */
  onRowClick?: (rowIdx: number, row: R, column: CalculatedColumn<R, SR>) => void;
  /** Function called whenever selected cell is changed */
  onSelectedCellChange?: (position: Position) => void;

  /**
   * Toggles and modes
   */
  cellNavigationMode?: CellNavigationMode;

  /**
   * Miscellaneous
   */
  /** The node where the editor portal should mount. */
  editorPortalTarget?: Element;
  rowClass?: (row: R) => string | undefined;
}

export default function Viewport<R, SR>({
  // Grid and data Props
  rowKeyGetter,
  onRowsChange,
  // Dimensions props
  rowHeight = DEFAULT_ROW_HEIGHT,
  // Feature props
  selectedRows,
  onSelectedRowsChange,
  rowGrouper,
  expandedGroupIds,
  onExpandedGroupIdsChange,
  // Custom renderers
  rowRenderer: RowRenderer = Row,
  // Event props
  onRowClick,
  onSelectedCellChange,
  onFill,
  onPaste,
  // Toggles and modes
  cellNavigationMode = 'NONE',
  // Miscellaneous
  editorPortalTarget = body,
  rowClass
}: ViewportProps<R, SR>) {
  /**
   * states
   */
  const [selectedPosition, setSelectedPosition] = useState<SelectCellState | EditCellState<R>>({ idx: -1, rowIdx: -1, mode: 'SELECT' });
  const [copiedCell, setCopiedCell] = useState<{ row: R; columnKey: string } | null>(null);
  const [draggedOverRowIdx, setOverRowIdx] = useState<number | undefined>(undefined);

  /**
   * refs
   */
  const focusSinkRef = useRef<HTMLDivElement>(null);
  const prevSelectedPosition = useRef(selectedPosition);
  const latestDraggedOverRowIdx = useRef(draggedOverRowIdx);
  const lastSelectedRowIdx = useRef(-1);
  const isCellFocusable = useRef(false);

  /**
   * The identity of the wrapper function is stable so it won't break memoization
   */
  const selectRowWrapper = useLatestFunc(selectRow);
  const selectCellWrapper = useLatestFunc(selectCell);
  const toggleGroupWrapper = useLatestFunc(toggleGroup);
  const handleFormatterRowChangeWrapper = useLatestFunc(updateRow);

  const viewportColumns = useColumns<R, SR>();
  const {
    columns,
    rows,
    rawRows,
    rowOverscanStartIdx,
    rowOverscanEndIdx,
    clientHeight,
    totalHeaderHeight,
    headerRowsCount,
    groupBy,
    isGroupRow,
    isDragging,
    setDragging,
    scrollToCell
  } = useViewport<R, SR>();

  /**
   * computed values
   */
  const isSelectable = selectedRows !== undefined && onSelectedRowsChange !== undefined;

  const hasGroups = groupBy.length > 0 && typeof rowGrouper === 'function';
  const minColIdx = hasGroups ? -1 : 0;

  // Cell drag is not supported on a treegrid
  const enableCellDragAndDrop = hasGroups ? false : onFill !== undefined;

  /**
   * effects
   */
  useLayoutEffect(() => {
    if (selectedPosition === prevSelectedPosition.current || selectedPosition.mode === 'EDIT' || !isCellWithinBounds(selectedPosition)) return;
    prevSelectedPosition.current = selectedPosition;
    scrollToCell(selectedPosition);

    if (isCellFocusable.current) {
      isCellFocusable.current = false;
      return;
    }
    focusSinkRef.current!.focus({ preventScroll: true });
  });

  /**
  * callbacks
  */
  const setDraggedOverRowIdx = useCallback((rowIdx?: number) => {
    setOverRowIdx(rowIdx);
    latestDraggedOverRowIdx.current = rowIdx;
  }, []);

  /**
  * event handlers
  */
  function selectRow({ rowIdx, checked, isShiftClick }: SelectRowEvent) {
    if (!onSelectedRowsChange) return;

    assertIsValidKeyGetter(rowKeyGetter);
    const newSelectedRows = new Set(selectedRows);
    const row = rows[rowIdx];
    if (isGroupRow(row)) {
      for (const childRow of row.childRows) {
        const rowKey = rowKeyGetter(childRow);
        if (checked) {
          newSelectedRows.add(rowKey);
        } else {
          newSelectedRows.delete(rowKey);
        }
      }
      onSelectedRowsChange(newSelectedRows);
      return;
    }

    const rowKey = rowKeyGetter(row);
    if (checked) {
      newSelectedRows.add(rowKey);
      const previousRowIdx = lastSelectedRowIdx.current;
      lastSelectedRowIdx.current = rowIdx;
      if (isShiftClick && previousRowIdx !== -1 && previousRowIdx !== rowIdx) {
        const step = Math.sign(rowIdx - previousRowIdx);
        for (let i = previousRowIdx + step; i !== rowIdx; i += step) {
          const row = rows[i];
          if (isGroupRow(row)) continue;
          newSelectedRows.add(rowKeyGetter(row));
        }
      }
    } else {
      newSelectedRows.delete(rowKey);
      lastSelectedRowIdx.current = -1;
    }

    onSelectedRowsChange(newSelectedRows);
  }

  function toggleGroup(expandedGroupId: unknown) {
    if (!onExpandedGroupIdsChange) return;
    const newExpandedGroupIds = new Set(expandedGroupIds);
    if (newExpandedGroupIds.has(expandedGroupId)) {
      newExpandedGroupIds.delete(expandedGroupId);
    } else {
      newExpandedGroupIds.add(expandedGroupId);
    }
    onExpandedGroupIdsChange(newExpandedGroupIds);
  }

  function onGridFocus() {
    if (!isCellWithinBounds(selectedPosition)) {
      // Tabbing into the grid should initiate keyboard navigation
      const initialPosition: SelectCellState = { idx: 0, rowIdx: 0, mode: 'SELECT' };
      if (isCellWithinBounds(initialPosition)) {
        setSelectedPosition(initialPosition);
      }
    } else {
      // otherwise if we already have a selected cell, we should scroll back to it when focusing the grid
      scrollToCell(selectedPosition);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const { key, keyCode } = event;
    const row = rows[selectedPosition.rowIdx];

    if (
      onPaste
      && isCtrlKeyHeldDown(event)
      && isCellWithinBounds(selectedPosition)
      && !isGroupRow(row)
      && selectedPosition.idx !== -1
      && selectedPosition.mode === 'SELECT'
    ) {
      // event.key may differ by keyboard input language, so we use event.keyCode instead
      // event.nativeEvent.code cannot be used either as it would break copy/paste for the DVORAK layout
      const cKey = 67;
      const vKey = 86;
      if (keyCode === cKey) {
        handleCopy();
        return;
      }
      if (keyCode === vKey) {
        handlePaste();
        return;
      }
    }

    if (
      isCellWithinBounds(selectedPosition)
      && isGroupRow(row)
      && selectedPosition.idx === -1
      && (
        // Collapse the current group row if it is focused and is in expanded state
        (key === 'ArrowLeft' && row.isExpanded)
        // Expand the current group row if it is focused and is in collapsed state
        || (key === 'ArrowRight' && !row.isExpanded)
      )) {
      event.preventDefault(); // Prevents scrolling
      toggleGroup(row.id);
      return;
    }

    switch (event.key) {
      case 'Escape':
        setCopiedCell(null);
        closeEditor();
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Tab':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        navigate(event);
        break;
      default:
        handleCellInput(event);
        break;
    }
  }

  function handleFocus() {
    isCellFocusable.current = true;
  }

  function getRawRowIdx(rowIdx: number) {
    return hasGroups ? rawRows.indexOf(rows[rowIdx] as R) : rowIdx;
  }

  function updateRow(rowIdx: number, row: R) {
    if (typeof onRowsChange !== 'function') return;
    const updatedRows = [...rawRows];
    updatedRows[rowIdx] = row;
    onRowsChange(updatedRows, {
      indexes: [rowIdx],
      column: columns[selectedPosition.idx]
    });
  }

  function commitEditorChanges() {
    if (
      columns[selectedPosition.idx]?.editor === undefined
      || selectedPosition.mode === 'SELECT'
      || selectedPosition.row === selectedPosition.originalRow) {
      return;
    }

    const rowIdx = getRawRowIdx(selectedPosition.rowIdx);
    updateRow(rowIdx, selectedPosition.row);
  }

  function handleCopy() {
    const { idx, rowIdx } = selectedPosition;
    setCopiedCell({ row: rawRows[getRawRowIdx(rowIdx)], columnKey: columns[idx].key });
  }

  function handlePaste() {
    const { idx, rowIdx } = selectedPosition;
    const targetRow = rawRows[getRawRowIdx(rowIdx)];
    if (
      !onPaste
      || !onRowsChange
      || copiedCell === null
      || !isCellEditable(selectedPosition)
    ) {
      return;
    }

    const updatedTargetRow = onPaste({
      sourceRow: copiedCell.row,
      sourceColumnKey: copiedCell.columnKey,
      targetRow,
      targetColumnKey: columns[idx].key
    });

    updateRow(rowIdx, updatedTargetRow);
  }

  function handleCellInput(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!isCellWithinBounds(selectedPosition)) return;
    const row = rows[selectedPosition.rowIdx];
    if (isGroupRow(row)) return;
    const { key } = event;
    const column = columns[selectedPosition.idx];

    if (selectedPosition.mode === 'EDIT') {
      if (key === 'Enter') {
        // Custom editors can listen for the event and stop propagation to prevent commit
        commitEditorChanges();
        closeEditor();
      }
      return;
    }

    column.editorOptions?.onCellKeyDown?.(event);
    if (event.isDefaultPrevented()) return;

    if (isCellEditable(selectedPosition) && isDefaultCellInput(event)) {
      setSelectedPosition(({ idx, rowIdx }) => ({
        idx,
        rowIdx,
        key,
        mode: 'EDIT',
        row,
        originalRow: row
      }));
    }
  }

  function handleDragEnd() {
    const overRowIdx = latestDraggedOverRowIdx.current;
    if (overRowIdx === undefined || !onFill || !onRowsChange) return;

    const { idx, rowIdx } = selectedPosition;
    const sourceRow = rawRows[rowIdx];
    const startRowIndex = rowIdx < overRowIdx ? rowIdx + 1 : overRowIdx;
    const endRowIndex = rowIdx < overRowIdx ? overRowIdx + 1 : rowIdx;
    const targetRows = rawRows.slice(startRowIndex, endRowIndex);
    const column = columns[idx];
    const updatedTargetRows = onFill({ columnKey: column.key, sourceRow, targetRows });
    const updatedRows = [...rawRows];
    const indexes: number[] = [];

    for (let i = startRowIndex; i < endRowIndex; i++) {
      updatedRows[i] = updatedTargetRows[i - startRowIndex];
      indexes.push(i);
    }

    onRowsChange(updatedRows, { indexes, column });
    setDraggedOverRowIdx(undefined);
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement, MouseEvent>) {
    if (event.buttons !== 1) return;
    setDragging(true);
    window.addEventListener('mouseover', onMouseOver);
    window.addEventListener('mouseup', onMouseUp);

    function onMouseOver(event: MouseEvent) {
      // Trigger onMouseup in edge cases where we release the mouse button but `mouseup` isn't triggered,
      // for example when releasing the mouse button outside the iframe the grid is rendered in.
      // https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons
      if (event.buttons !== 1) onMouseUp();
    }

    function onMouseUp() {
      window.removeEventListener('mouseover', onMouseOver);
      window.removeEventListener('mouseup', onMouseUp);
      setDragging(false);
      handleDragEnd();
    }
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (!onFill || !onRowsChange) return;

    const { idx, rowIdx } = selectedPosition;
    const sourceRow = rawRows[rowIdx];
    const targetRows = rawRows.slice(rowIdx + 1);
    const column = columns[idx];
    const updatedTargetRows = onFill({ columnKey: column.key, sourceRow, targetRows });
    const updatedRows = [...rawRows];
    const indexes: number[] = [];

    for (let i = rowIdx + 1; i < updatedRows.length; i++) {
      updatedRows[i] = updatedTargetRows[i - rowIdx - 1];
      indexes.push(i);
    }

    onRowsChange(updatedRows, { indexes, column });
  }

  function handleEditorRowChange(row: Readonly<R>, commitChanges?: boolean) {
    if (selectedPosition.mode === 'SELECT') return;
    if (commitChanges) {
      updateRow(getRawRowIdx(selectedPosition.rowIdx), row);
      closeEditor();
    } else {
      setSelectedPosition(position => ({ ...position, row }));
    }
  }

  function handleOnClose(commitChanges?: boolean) {
    if (commitChanges) {
      commitEditorChanges();
    }
    closeEditor();
  }

  /**
   * utils
   */
  function isCellWithinBounds({ idx, rowIdx }: Position): boolean {
    return rowIdx >= 0 && rowIdx < rows.length && idx >= minColIdx && idx < columns.length;
  }

  function isCellEditable(position: Position): boolean {
    return isCellWithinBounds(position)
      && isSelectedCellEditable<R, SR>({ columns, rows, selectedPosition: position, isGroupRow });
  }

  function selectCell(position: Position, enableEditor = false): void {
    if (!isCellWithinBounds(position)) return;
    commitEditorChanges();

    if (enableEditor && isCellEditable(position)) {
      const row = rows[position.rowIdx] as R;
      setSelectedPosition({ ...position, mode: 'EDIT', key: null, row, originalRow: row });
    } else {
      setSelectedPosition({ ...position, mode: 'SELECT' });
    }
    onSelectedCellChange?.({ ...position });
  }

  function closeEditor() {
    if (selectedPosition.mode === 'SELECT') return;
    setSelectedPosition(({ idx, rowIdx }) => ({ idx, rowIdx, mode: 'SELECT' }));
  }

  function getNextPosition(key: string, ctrlKey: boolean, shiftKey: boolean): Position {
    const { idx, rowIdx } = selectedPosition;
    const row = rows[rowIdx];
    const isRowSelected = isCellWithinBounds(selectedPosition) && idx === -1;

    // If a group row is focused, and it is collapsed, move to the parent group row (if there is one).
    if (
      key === 'ArrowLeft'
      && isRowSelected
      && isGroupRow(row)
      && !row.isExpanded
      && row.level !== 0
    ) {
      let parentRowIdx = -1;
      for (let i = selectedPosition.rowIdx - 1; i >= 0; i--) {
        const parentRow = rows[i];
        if (isGroupRow(parentRow) && parentRow.id === row.parentId) {
          parentRowIdx = i;
          break;
        }
      }
      if (parentRowIdx !== -1) {
        return { idx, rowIdx: parentRowIdx };
      }
    }

    switch (key) {
      case 'ArrowUp':
        return { idx, rowIdx: rowIdx - 1 };
      case 'ArrowDown':
        return { idx, rowIdx: rowIdx + 1 };
      case 'ArrowLeft':
        return { idx: idx - 1, rowIdx };
      case 'ArrowRight':
        return { idx: idx + 1, rowIdx };
      case 'Tab':
        if (selectedPosition.idx === -1 && selectedPosition.rowIdx === -1) {
          return shiftKey ? { idx: columns.length - 1, rowIdx: rows.length - 1 } : { idx: 0, rowIdx: 0 };
        }
        return { idx: idx + (shiftKey ? -1 : 1), rowIdx };
      case 'Home':
        // If row is selected then move focus to the first row
        if (isRowSelected) return { idx, rowIdx: 0 };
        return ctrlKey ? { idx: 0, rowIdx: 0 } : { idx: 0, rowIdx };
      case 'End':
        // If row is selected then move focus to the last row.
        if (isRowSelected) return { idx, rowIdx: rows.length - 1 };
        return ctrlKey ? { idx: columns.length - 1, rowIdx: rows.length - 1 } : { idx: columns.length - 1, rowIdx };
      case 'PageUp':
        return { idx, rowIdx: rowIdx - Math.floor(clientHeight / rowHeight) };
      case 'PageDown':
        return { idx, rowIdx: rowIdx + Math.floor(clientHeight / rowHeight) };
      default:
        return selectedPosition;
    }
  }

  function navigate(event: React.KeyboardEvent<HTMLDivElement>) {
    if (selectedPosition.mode === 'EDIT') {
      const onNavigation = columns[selectedPosition.idx].editorOptions?.onNavigation ?? onEditorNavigation;
      if (!onNavigation(event)) return;
    }
    const { key, shiftKey } = event;
    let mode = cellNavigationMode;
    if (key === 'Tab') {
      // If we are in a position to leave the grid, stop editing but stay in that cell
      if (canExitGrid({ shiftKey, cellNavigationMode, columns, rowsCount: rows.length, selectedPosition })) {
        commitEditorChanges();
        // Allow focus to leave the grid so the next control in the tab order can be focused
        return;
      }

      mode = cellNavigationMode === 'NONE'
        ? 'CHANGE_ROW'
        : cellNavigationMode;
    }

    // Do not allow focus to leave
    event.preventDefault();

    const ctrlKey = isCtrlKeyHeldDown(event);
    let nextPosition = getNextPosition(key, ctrlKey, shiftKey);
    nextPosition = getNextSelectedCellPosition({
      columns,
      rowsCount: rows.length,
      cellNavigationMode: mode,
      nextPosition
    });

    selectCell(nextPosition);
  }

  function getDraggedOverCellIdx(currentRowIdx: number): number | undefined {
    if (draggedOverRowIdx === undefined) return;
    const { rowIdx } = selectedPosition;

    const isDraggedOver = rowIdx < draggedOverRowIdx
      ? rowIdx < currentRowIdx && currentRowIdx <= draggedOverRowIdx
      : rowIdx > currentRowIdx && currentRowIdx >= draggedOverRowIdx;

    return isDraggedOver ? selectedPosition.idx : undefined;
  }

  function getSelectedCellProps(rowIdx: number): SelectedCellProps | EditCellProps<R> | undefined {
    if (selectedPosition.rowIdx !== rowIdx) return;

    if (selectedPosition.mode === 'EDIT') {
      return {
        mode: 'EDIT',
        idx: selectedPosition.idx,
        onKeyDown: handleKeyDown,
        editorProps: {
          editorPortalTarget,
          rowHeight,
          row: selectedPosition.row,
          onRowChange: handleEditorRowChange,
          onClose: handleOnClose
        }
      };
    }

    return {
      mode: 'SELECT',
      idx: selectedPosition.idx,
      onFocus: handleFocus,
      onKeyDown: handleKeyDown,
      dragHandleProps: enableCellDragAndDrop && isCellEditable(selectedPosition)
        ? { onMouseDown: handleMouseDown, onDoubleClick: handleDoubleClick }
        : undefined
    };
  }

  function getViewportRows() {
    const rowElements = [];
    let startRowIndex = 0;
    for (let rowIdx = rowOverscanStartIdx; rowIdx <= rowOverscanEndIdx; rowIdx++) {
      const row = rows[rowIdx];
      const top = rowIdx * rowHeight + totalHeaderHeight;
      if (isGroupRow(row)) {
        ({ startRowIndex } = row);
        rowElements.push(
          <GroupRowRenderer<R, SR>
            aria-level={row.level + 1} // aria-level is 1-based
            aria-setsize={row.setSize}
            aria-posinset={row.posInSet + 1} // aria-posinset is 1-based
            aria-rowindex={headerRowsCount + startRowIndex + 1} // aria-rowindex is 1 based
            key={row.id}
            id={row.id}
            groupKey={row.groupKey}
            viewportColumns={viewportColumns}
            childRows={row.childRows}
            rowIdx={rowIdx}
            top={top}
            level={row.level}
            isExpanded={row.isExpanded}
            selectedCellIdx={selectedPosition.rowIdx === rowIdx ? selectedPosition.idx : undefined}
            isRowSelected={isSelectable && row.childRows.every(cr => selectedRows?.has(rowKeyGetter!(cr)))}
            onFocus={selectedPosition.rowIdx === rowIdx ? handleFocus : undefined}
            onKeyDown={selectedPosition.rowIdx === rowIdx ? handleKeyDown : undefined}
            selectCell={selectCellWrapper}
            selectRow={selectRowWrapper}
            toggleGroup={toggleGroupWrapper}
          />
        );
        continue;
      }

      startRowIndex++;
      let key: React.Key = hasGroups ? startRowIndex : rowIdx;
      let isRowSelected = false;
      if (typeof rowKeyGetter === 'function') {
        key = rowKeyGetter(row);
        isRowSelected = selectedRows?.has(key) ?? false;
      }

      rowElements.push(
        <RowRenderer
          aria-rowindex={headerRowsCount + (hasGroups ? startRowIndex : rowIdx) + 1} // aria-rowindex is 1 based
          aria-selected={isSelectable ? isRowSelected : undefined}
          key={key}
          rowIdx={rowIdx}
          row={row}
          viewportColumns={viewportColumns}
          isRowSelected={isRowSelected}
          onRowClick={onRowClick}
          rowClass={rowClass}
          top={top}
          copiedCellIdx={copiedCell !== null && copiedCell.row === row ? columns.findIndex(c => c.key === copiedCell.columnKey) : undefined}
          draggedOverCellIdx={getDraggedOverCellIdx(rowIdx)}
          setDraggedOverRowIdx={isDragging ? setDraggedOverRowIdx : undefined}
          selectedCellProps={getSelectedCellProps(rowIdx)}
          onRowChange={handleFormatterRowChangeWrapper}
          selectCell={selectCellWrapper}
          selectRow={selectRowWrapper}
        />
      );
    }

    return rowElements;
  }

  // Reset the positions if the current values are no longer valid. This can happen if a column or row is removed
  if (selectedPosition.idx >= columns.length || selectedPosition.rowIdx >= rows.length) {
    setSelectedPosition({ idx: -1, rowIdx: -1, mode: 'SELECT' });
    setDraggedOverRowIdx(undefined);
  }

  if (selectedPosition.mode === 'EDIT' && rows[selectedPosition.rowIdx] !== selectedPosition.originalRow) {
    // Discard changes if rows are updated from outside
    closeEditor();
  }

  return (
    <>
      <div
        ref={focusSinkRef}
        tabIndex={0}
        className={focusSinkClassname}
        onKeyDown={handleKeyDown}
        onFocus={onGridFocus}
      />
      <div style={{ height: Math.max(rows.length * rowHeight, clientHeight) }} />
      {getViewportRows()}
    </>
  );
}