import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  FilePlus2,
  FileSpreadsheet,
  Grid3X3,
  Italic,
  LogOut,
  Mail,
  PaintBucket,
  Percent,
  Plus,
  Redo2,
  Save,
  Search,
  Settings,
  Sigma,
  Trash2,
  Underline,
  Undo2,
  Upload,
} from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AttachmentRecord,
  SpreadsheetCell,
  SpreadsheetCellStyle,
  SpreadsheetSheet,
  WorkbookData,
  WorkbookRecord,
  WorkbookSummary,
} from "../shared/types";
import {
  isSpreadsheetAttachment,
  MAX_SPREADSHEET_IMPORT_BYTES,
  spreadsheetImportFilename,
} from "../shared/spreadsheetAttachments";
import { mailApi } from "./api";
import {
  cellAddress,
  cellFromInput,
  columnName,
  createBlankWorkbook,
  evaluateCell,
  formatCellValue,
  parseCellAddress,
  rawCellInput,
  sheetExtent,
} from "./spreadsheetModel";
import "./spreadsheet.css";

type RibbonTab = "home" | "insert" | "page layout" | "formulas" | "data" | "review" | "view" | "help";
type SaveState = "saved" | "saving" | "unsaved" | "error";

const templates = [
  { name: "Blank workbook", description: "Start with an empty spreadsheet", icon: FilePlus2, create: createBlankWorkbook },
  { name: "Personal budget", description: "Track income, spending, and balance", icon: Percent, create: createBudgetWorkbook },
  { name: "Project tracker", description: "Plan owners, dates, and status", icon: Check, create: createProjectWorkbook },
];

export function SpreadsheetApp(props: {
  userEmail: string;
  initialAttachment?: AttachmentRecord | null;
  onInitialAttachmentHandled?: () => void;
  onExit: () => void;
  onLogout: () => void;
}) {
  const [workbooks, setWorkbooks] = useState<WorkbookSummary[]>([]);
  const [activeWorkbook, setActiveWorkbook] = useState<WorkbookRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const [selectedAddress, setSelectedAddress] = useState("A1");
  const [draftInput, setDraftInput] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [zoom, setZoom] = useState(100);
  const importRef = useRef<HTMLInputElement>(null);
  const toolSearchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(0);
  const initialAttachmentRef = useRef<string | null>(null);

  const loadWorkbooks = useCallback(async () => {
    setLoading(true);
    try {
      setWorkbooks((await mailApi.workbooks()).workbooks);
    } catch {
      setStatus("Workbooks could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadWorkbooks(), [loadWorkbooks]);

  useEffect(() => {
    const attachment = props.initialAttachment;
    if (!attachment || initialAttachmentRef.current === attachment.id) return;
    initialAttachmentRef.current = attachment.id;
    void openMailAttachment(attachment).finally(() => props.onInitialAttachmentHandled?.());
  }, [props.initialAttachment?.id]);

  const saveNow = useCallback(async (record: WorkbookRecord, revision = revisionRef.current) => {
    setSaveState("saving");
    try {
      const result = await mailApi.saveWorkbook(record.id, {
        title: record.title.trim() || "Book",
        workbook: record.workbook,
      });
      if (revision === revisionRef.current) {
        setDirty(false);
        setSaveState("saved");
        setActiveWorkbook((current) => current?.id === record.id ? { ...current, updatedAt: result.updatedAt } : current);
      }
    } catch {
      setSaveState("error");
      setStatus("This workbook could not be saved. Your changes remain in the grid.");
    }
  }, []);

  useEffect(() => {
    if (!activeWorkbook || !dirty) return;
    const revision = revisionRef.current;
    const timeout = window.setTimeout(() => void saveNow(activeWorkbook, revision), 900);
    return () => window.clearTimeout(timeout);
  }, [activeWorkbook, dirty, saveNow]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (!activeWorkbook || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void saveNow(activeWorkbook);
      } else if (key === "o") {
        event.preventDefault();
        importRef.current?.click();
      } else if (key === "q") {
        event.preventDefault();
        toolSearchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [activeWorkbook, saveNow]);

  const activeSheet = useMemo(() => {
    if (!activeWorkbook) return null;
    return activeWorkbook.workbook.sheets.find((sheet) => sheet.id === activeWorkbook.workbook.activeSheetId)
      || activeWorkbook.workbook.sheets[0]
      || null;
  }, [activeWorkbook]);

  const selectedCell = activeSheet?.cells[selectedAddress];
  const selectedStyle = selectedCell?.style || {};

  function markWorkbookChanged(update: (workbook: WorkbookData) => WorkbookData) {
    revisionRef.current += 1;
    setDirty(true);
    setSaveState("unsaved");
    setActiveWorkbook((current) => current ? { ...current, workbook: update(current.workbook) } : current);
  }

  function updateActiveSheet(update: (sheet: SpreadsheetSheet) => SpreadsheetSheet) {
    markWorkbookChanged((workbook) => ({
      ...workbook,
      sheets: workbook.sheets.map((sheet) => sheet.id === workbook.activeSheetId ? update(sheet) : sheet),
    }));
  }

  function commitCell(address = selectedAddress, input = draftInput) {
    updateActiveSheet((sheet) => {
      const next = { ...sheet.cells };
      const cell = cellFromInput(input, next[address]);
      if (cell) next[address] = cell;
      else delete next[address];
      return { ...sheet, cells: next };
    });
  }

  function selectCell(address: string, focus = false) {
    setSelectedAddress(address);
    setDraftInput(rawCellInput(activeSheet?.cells[address]));
    if (focus) window.requestAnimationFrame(() => gridRef.current?.querySelector<HTMLInputElement>(`[data-cell="${address}"]`)?.focus());
  }

  function moveSelection(rowDelta: number, columnDelta: number) {
    const parsed = parseCellAddress(selectedAddress) || { row: 0, column: 0 };
    const next = cellAddress(Math.max(0, Math.min(1_999, parsed.row + rowDelta)), Math.max(0, Math.min(99, parsed.column + columnDelta)));
    selectCell(next, true);
  }

  function changeCellStyle(patch: Partial<SpreadsheetCellStyle>) {
    updateActiveSheet((sheet) => {
      const current = sheet.cells[selectedAddress] || { value: null };
      const style = { ...current.style, ...patch };
      Object.keys(style).forEach((key) => style[key as keyof SpreadsheetCellStyle] === undefined && delete style[key as keyof SpreadsheetCellStyle]);
      return { ...sheet, cells: { ...sheet.cells, [selectedAddress]: { ...current, style } } };
    });
  }

  function toggleStyle(key: "bold" | "italic" | "underline") {
    changeCellStyle({ [key]: !selectedStyle[key] });
  }

  function pasteCells(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    event.preventDefault();
    const origin = parseCellAddress(selectedAddress);
    if (!origin) return;
    const rows = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((row) => row.split("\t"));
    updateActiveSheet((sheet) => {
      const cells = { ...sheet.cells };
      rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
        const address = cellAddress(origin.row + rowIndex, origin.column + columnIndex);
        const cell = cellFromInput(value, cells[address]);
        if (cell) cells[address] = cell;
        else delete cells[address];
      }));
      return { ...sheet, cells };
    });
    setDraftInput(rows[0]?.[0] || "");
    setStatus(`Pasted ${rows.reduce((count, row) => count + row.length, 0)} cells.`);
  }

  function cellKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCell();
      moveSelection(event.shiftKey ? -1 : 1, 0);
    } else if (event.key === "Tab") {
      event.preventDefault();
      commitCell();
      moveSelection(0, event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraftInput(rawCellInput(selectedCell));
      event.currentTarget.blur();
    } else if ((event.key === "Delete" || event.key === "Backspace") && !event.currentTarget.value) {
      event.preventDefault();
      setDraftInput("");
      commitCell(selectedAddress, "");
    }
  }

  async function createWorkbook(template = templates[0]) {
    setOpening(true);
    setStatus("");
    try {
      const result = await mailApi.createWorkbook({
        title: template.name === "Blank workbook" ? "Book" : template.name,
        workbook: template.create(),
      });
      openRecord(result.workbook);
    } catch {
      setStatus("A new workbook could not be created.");
    } finally {
      setOpening(false);
    }
  }

  function openRecord(record: WorkbookRecord) {
    revisionRef.current = 0;
    setDirty(false);
    setSaveState("saved");
    setActiveWorkbook(record);
    const sheet = record.workbook.sheets.find((item) => item.id === record.workbook.activeSheetId) || record.workbook.sheets[0];
    setSelectedAddress("A1");
    setDraftInput(rawCellInput(sheet?.cells.A1));
  }

  async function openWorkbook(id: string): Promise<boolean> {
    setOpening(true);
    setStatus("");
    try {
      openRecord((await mailApi.workbook(id)).workbook);
      return true;
    } catch {
      setStatus("That workbook could not be opened.");
      return false;
    } finally {
      setOpening(false);
    }
  }

  async function returnToWorkbooks() {
    if (activeWorkbook && dirty) await saveNow(activeWorkbook);
    setActiveWorkbook(null);
    await loadWorkbooks();
  }

  async function openMailAttachment(attachment: AttachmentRecord) {
    if (!isSpreadsheetAttachment(attachment)) {
      setStatus("Only .xlsx attachments can be opened here.");
      return;
    }
    if (attachment.sizeBytes > MAX_SPREADSHEET_IMPORT_BYTES) {
      setStatus("That attachment is larger than the 15 MB spreadsheet import limit. Download the original from Mail instead.");
      return;
    }
    setOpening(true);
    setStatus(`Opening ${attachment.filename} from Mail…`);
    try {
      const linked = await mailApi.spreadsheetForAttachment(attachment.id);
      if (linked.workbookId) {
        const opened = await openWorkbook(linked.workbookId);
        if (opened) setStatus("Opened the existing editable copy. The original mail attachment is unchanged.");
        return;
      }
      const file = await mailApi.attachmentFile(linked.attachment, spreadsheetImportFilename(linked.attachment.filename));
      await importWorkbook(file, attachment.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That mail attachment could not be opened in spreadsheet.");
    } finally {
      setOpening(false);
    }
  }

  async function importWorkbook(file: File | undefined, sourceAttachmentId: string | null = null): Promise<boolean> {
    if (!file) return false;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setStatus("Choose a .xlsx file.");
      return false;
    }
    if (file.size > MAX_SPREADSHEET_IMPORT_BYTES) {
      setStatus("That workbook is larger than the 15 MB import limit.");
      return false;
    }
    setOpening(true);
    setStatus("Importing workbook…");
    try {
      const imported = await (await import("./xlsx")).importXlsx(await file.arrayBuffer());
      const result = await mailApi.createWorkbook({
        title: file.name.replace(/\.xlsx$/i, "") || "Imported workbook",
        workbook: imported.workbook,
        sourceAttachmentId,
      });
      openRecord(result.workbook);
      setStatus(sourceAttachmentId
        ? result.reused
          ? "Opened the existing editable copy. The original mail attachment is unchanged."
          : imported.warnings.length
            ? `Opened from Mail with ${imported.warnings.length} compatibility note${imported.warnings.length === 1 ? "" : "s"}. The original attachment is unchanged.`
            : "Opened an editable workbook from Mail. The original attachment is unchanged."
        : imported.warnings.length
          ? `Imported with ${imported.warnings.length} compatibility note${imported.warnings.length === 1 ? "" : "s"}.`
          : "Workbook imported.");
      return true;
    } catch {
      setStatus("The .xlsx file could not be imported.");
      return false;
    } finally {
      setOpening(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function downloadWorkbook() {
    if (!activeWorkbook) return;
    setStatus("Preparing spreadsheet workbook…");
    try {
      await (await import("./xlsx")).downloadXlsx(activeWorkbook.title, activeWorkbook.workbook);
      setStatus("Downloaded a .xlsx copy.");
    } catch {
      setStatus("The .xlsx download could not be created.");
    }
  }

  async function deleteWorkbook() {
    if (!activeWorkbook || !window.confirm(`Remove “${activeWorkbook.title}” from your workbook list?`)) return;
    try {
      await mailApi.deleteWorkbook(activeWorkbook.id);
      setActiveWorkbook(null);
      setStatus("Workbook removed.");
      await loadWorkbooks();
    } catch {
      setStatus("The workbook could not be removed.");
    }
  }

  function addSheet() {
    if (!activeWorkbook || activeWorkbook.workbook.sheets.length >= 20) {
      setStatus("A workbook can contain up to 20 sheets.");
      return;
    }
    const existing = new Set(activeWorkbook.workbook.sheets.map((sheet) => sheet.name.toLowerCase()));
    let number = activeWorkbook.workbook.sheets.length + 1;
    while (existing.has(`sheet${number}`)) number += 1;
    const sheet: SpreadsheetSheet = { id: crypto.randomUUID(), name: `Sheet${number}`, cells: {} };
    markWorkbookChanged((workbook) => ({ ...workbook, activeSheetId: sheet.id, sheets: [...workbook.sheets, sheet] }));
    setSelectedAddress("A1");
    setDraftInput("");
  }

  function activateSheet(id: string) {
    markWorkbookChanged((workbook) => ({ ...workbook, activeSheetId: id }));
    const sheet = activeWorkbook?.workbook.sheets.find((item) => item.id === id);
    setSelectedAddress("A1");
    setDraftInput(rawCellInput(sheet?.cells.A1));
  }

  function renameSheet(sheet: SpreadsheetSheet) {
    const name = window.prompt("Rename worksheet", sheet.name)?.trim();
    if (!name || name === sheet.name) return;
    if (name.length > 31 || /[\\/?*\[\]:]/.test(name)) {
      setStatus("Sheet names must be 31 characters or fewer and cannot contain \\ / ? * [ ] :");
      return;
    }
    if (activeWorkbook?.workbook.sheets.some((item) => item.id !== sheet.id && item.name.toLowerCase() === name.toLowerCase())) {
      setStatus("Each sheet needs a unique name.");
      return;
    }
    markWorkbookChanged((workbook) => ({ ...workbook, sheets: workbook.sheets.map((item) => item.id === sheet.id ? { ...item, name } : item) }));
  }

  function deleteSheet(sheet: SpreadsheetSheet) {
    if (!activeWorkbook || activeWorkbook.workbook.sheets.length === 1) {
      setStatus("A workbook must keep at least one sheet.");
      return;
    }
    if (!window.confirm(`Delete worksheet “${sheet.name}”?`)) return;
    markWorkbookChanged((workbook) => {
      const sheets = workbook.sheets.filter((item) => item.id !== sheet.id);
      return { ...workbook, sheets, activeSheetId: workbook.activeSheetId === sheet.id ? sheets[0].id : workbook.activeSheetId };
    });
  }

  function runToolSearch(value: string) {
    const query = value.trim().toLowerCase();
    if (!query) return;
    if (query.includes("open") || query.includes("import")) importRef.current?.click();
    else if (query.includes("download") || query.includes("export")) void downloadWorkbook();
    else if (query.includes("formula") || query.includes("function")) { setActiveTab("formulas"); setStatus("Use the formula bar or begin a cell with =. Try =SUM(A1:A10)."); }
    else if (query.includes("sheet")) addSheet();
    else setStatus(`No matching tool for “${value.trim()}”. Try import, download, formula, or new sheet.`);
  }

  if (!activeWorkbook) {
    return <div className="spreadsheet-app spreadsheet-start">
      <header className="spreadsheet-start-header"><button onClick={props.onExit}><Mail /> Mail</button><span className="spreadsheet-brand-icon">S</span><strong>cfmail Spreadsheets</strong><span /><small>{props.userEmail}</small><button className="spreadsheet-user" onClick={props.onLogout} title="Sign out"><b>{props.userEmail.slice(0, 1).toUpperCase()}</b><LogOut /></button></header>
      <main className="spreadsheet-start-main">
        <section className="spreadsheet-start-hero"><div><p>Create new</p><h1>Spreadsheets</h1><span>Create, calculate, edit, import, and export workbooks.</span></div><button onClick={() => importRef.current?.click()}><Upload /> Open .xlsx</button></section>
        <section className="spreadsheet-template-grid" aria-label="Workbook templates">
          {templates.map((template) => { const Icon = template.icon; return <button key={template.name} onClick={() => void createWorkbook(template)} disabled={opening}><i><Icon /></i><strong>{template.name}</strong><small>{template.description}</small></button>; })}
        </section>
        <section className="spreadsheet-recent" aria-labelledby="recent-workbooks-heading">
          <header><div><p>Your files</p><h2 id="recent-workbooks-heading">Recent workbooks</h2></div><button onClick={() => void loadWorkbooks()}>Refresh</button></header>
          {loading ? <div className="spreadsheet-loading"><span /> Loading workbooks…</div> : null}
          {!loading && !workbooks.length ? <div className="spreadsheet-empty"><FileSpreadsheet /><h3>No workbooks yet</h3><p>Choose a template above or import an .xlsx file.</p></div> : null}
          <div className="spreadsheet-workbook-list">{workbooks.map((record) => <button key={record.id} onClick={() => void openWorkbook(record.id)} disabled={opening}><i><FileSpreadsheet /></i><span><strong>{record.title}</strong><small>{record.preview || "Blank workbook"}</small></span><time>{relativeDate(record.updatedAt)}<small>{record.sheetCount} sheet{record.sheetCount === 1 ? "" : "s"} · {record.cellCount.toLocaleString()} cells</small></time></button>)}</div>
        </section>
        {status ? <p className="spreadsheet-start-status" role="status">{status}</p> : null}
      </main>
      <input ref={importRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => void importWorkbook(event.target.files?.[0])} />
    </div>;
  }

  if (!activeSheet) return null;
  const extent = sheetExtent(activeSheet);
  const displayedRows = Array.from({ length: extent.rows }, (_, index) => index);
  const displayedColumns = Array.from({ length: extent.columns }, (_, index) => index);
  const calculated = evaluateCell(activeSheet, selectedAddress);

  return <div className="spreadsheet-app spreadsheet-editor-shell" style={{ "--spreadsheet-zoom": zoom / 100 } as CSSProperties}>
    <header className="spreadsheet-titlebar">
      <button className="spreadsheet-launcher" onClick={props.onExit} title="Back to cfmail apps" aria-label="Back to Mail"><Grid3X3 /></button>
      <button className="spreadsheet-brand-icon" onClick={() => void returnToWorkbooks()} title="Spreadsheets home">S</button>
      <div className="spreadsheet-title-area"><label className="sr-only" htmlFor="workbook-title">Workbook title</label><input id="workbook-title" value={activeWorkbook.title} onChange={(event) => { revisionRef.current += 1; setDirty(true); setSaveState("unsaved"); setActiveWorkbook({ ...activeWorkbook, title: event.target.value }); }} onBlur={() => void saveNow(activeWorkbook)} /><span className={`spreadsheet-save-state ${saveState}`}>{saveState === "saved" ? <Check /> : saveState === "saving" ? <Cloud /> : <Save />}{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Save failed" : "Unsaved"}</span></div>
      <label className="spreadsheet-tool-search"><Search /><input ref={toolSearchRef} aria-label="Search tools and help" placeholder="Search tools and help" onKeyDown={(event) => event.key === "Enter" && runToolSearch(event.currentTarget.value)} /></label>
      <button className="spreadsheet-settings" onClick={() => setStatus("Workbook settings are available in the ribbon and sheet tabs.")} aria-label="Workbook settings"><Settings /></button>
      <button className="spreadsheet-user" onClick={props.onLogout} title="Sign out"><b>{props.userEmail.slice(0, 1).toUpperCase()}</b><LogOut /></button>
    </header>

    <div className="spreadsheet-commandbar"><nav aria-label="Spreadsheet ribbon"><button onClick={() => void returnToWorkbooks()}>File</button>{(["home", "insert", "page layout", "formulas", "data", "review", "view", "help"] as RibbonTab[]).map((tab) => <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{titleCase(tab)}</button>)}</nav><div><button onClick={() => setStatus(saveState === "saved" ? "All changes are saved." : "This workbook has unsaved changes.")}>Editing <ChevronDown /></button><button className="primary" onClick={() => void downloadWorkbook()}><Download /> Export .xlsx</button></div></div>

    <SpreadsheetRibbon tab={activeTab} style={selectedStyle} onStyle={changeCellStyle} onToggle={toggleStyle} onImport={() => importRef.current?.click()} onExport={() => void downloadWorkbook()} onDelete={() => void deleteWorkbook()} onStatus={setStatus} />

    <div className="spreadsheet-formula-row">
      <label><span className="sr-only">Cell address</span><input value={selectedAddress} onChange={(event) => setSelectedAddress(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter" && parseCellAddress(event.currentTarget.value)) selectCell(event.currentTarget.value.toUpperCase(), true); }} /></label>
      <span className="spreadsheet-fx">fx</span>
      <label><span className="sr-only">Formula bar</span><input value={draftInput} onChange={(event) => setDraftInput(event.target.value)} onFocus={() => setDraftInput(rawCellInput(selectedCell))} onBlur={() => commitCell()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitCell(); moveSelection(1, 0); } }} /></label>
    </div>

    <main className="spreadsheet-grid-viewport" ref={gridRef} aria-label={`${activeSheet.name} spreadsheet grid`}>
      <table className="spreadsheet-grid"><thead><tr><th className="spreadsheet-corner" />{displayedColumns.map((column) => <th key={column} style={{ width: activeSheet.columnWidths?.[columnName(column)] || 100 }}>{columnName(column)}</th>)}</tr></thead><tbody>{displayedRows.map((row) => <tr key={row}><th>{row + 1}</th>{displayedColumns.map((column) => {
        const address = cellAddress(row, column);
        const cell = activeSheet.cells[address];
        const selected = address === selectedAddress;
        const value = selected ? draftInput : formatCellValue(evaluateCell(activeSheet, address), cell?.style?.numberFormat);
        return <td key={address} className={selected ? "selected" : ""} style={{ width: activeSheet.columnWidths?.[columnName(column)] || 100 }}><input
          data-cell={address}
          aria-label={`Cell ${address}`}
          value={value}
          onFocus={() => { setSelectedAddress(address); setDraftInput(rawCellInput(cell)); }}
          onChange={(event) => setDraftInput(event.target.value)}
          onBlur={() => selected && commitCell(address, draftInput)}
          onKeyDown={cellKeyDown}
          onPaste={pasteCells}
          style={cellStyle(cell)}
        /></td>;
      })}</tr>)}</tbody></table>
    </main>

    <div className="spreadsheet-sheetbar"><button className="spreadsheet-add-sheet" onClick={addSheet} title="New sheet" aria-label="New sheet"><Plus /></button><div className="spreadsheet-sheet-tabs">{activeWorkbook.workbook.sheets.map((sheet) => <button key={sheet.id} className={sheet.id === activeWorkbook.workbook.activeSheetId ? "active" : ""} onClick={() => activateSheet(sheet.id)} onDoubleClick={() => renameSheet(sheet)} onContextMenu={(event) => { event.preventDefault(); deleteSheet(sheet); }}>{sheet.name}</button>)}</div><span className="spreadsheet-sheet-hint">Double-click to rename · right-click to delete</span></div>
    <footer className="spreadsheet-statusbar"><span>Ready</span><span>{selectedAddress}</span>{typeof calculated === "number" ? <span>Sum: {formatCellValue(calculated, selectedStyle.numberFormat)}</span> : null}<i /><button onClick={() => setZoom((value) => Math.max(50, value - 10))}>−</button><input type="range" aria-label="Workbook zoom" min="50" max="160" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button onClick={() => setZoom((value) => Math.min(160, value + 10))}>+</button><span>{zoom}%</span></footer>
    <div className="spreadsheet-live-status" aria-live="polite">{status}</div>
    <input ref={importRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => void importWorkbook(event.target.files?.[0])} />
  </div>;
}

function SpreadsheetRibbon(props: {
  tab: RibbonTab;
  style: SpreadsheetCellStyle;
  onStyle: (patch: Partial<SpreadsheetCellStyle>) => void;
  onToggle: (key: "bold" | "italic" | "underline") => void;
  onImport: () => void;
  onExport: () => void;
  onDelete: () => void;
  onStatus: (status: string) => void;
}) {
  if (props.tab !== "home") return <div className="spreadsheet-ribbon spreadsheet-ribbon-simple">
    {props.tab === "insert" ? <><RibbonButton icon={<Grid3X3 />} label="Table" onClick={() => props.onStatus("Paste a table directly into the selected cell to fill a range.")} /><RibbonButton icon={<FileSpreadsheet />} label="Chart" onClick={() => props.onStatus("Charts are not available.")} /></> : null}
    {props.tab === "page layout" ? <><RibbonButton icon={<FileSpreadsheet />} label="Print area" onClick={() => props.onStatus("The exported .xlsx preserves your worksheet data and formatting.")} /><RibbonButton icon={<PaintBucket />} label="Themes" onClick={() => props.onStatus("Use Home to apply cell colours and formatting.")} /></> : null}
    {props.tab === "formulas" ? <><RibbonButton icon={<Sigma />} label="AutoSum" onClick={() => props.onStatus("Enter =SUM(A1:A10) in a cell or formula bar.")} /><RibbonButton icon={<Search />} label="Functions" onClick={() => props.onStatus("Supported: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, and ABS.")} /></> : null}
    {props.tab === "data" ? <><RibbonButton icon={<Upload />} label="From .xlsx" onClick={props.onImport} /><RibbonButton icon={<Grid3X3 />} label="Sort & filter" onClick={() => props.onStatus("Sorting and filters are not available.")} /></> : null}
    {props.tab === "review" ? <><RibbonButton icon={<Check />} label="Check" onClick={() => props.onStatus("Formula errors appear directly in cells, including #DIV/0!, #REF!, and #CYCLE!.")} /><RibbonButton icon={<Copy />} label="Comments" onClick={() => props.onStatus("Cell comments are not available.")} /></> : null}
    {props.tab === "view" ? <><RibbonButton icon={<Grid3X3 />} label="Gridlines" onClick={() => props.onStatus("Gridlines and row/column headings are visible.")} /></> : null}
    {props.tab === "help" ? <><RibbonButton icon={<Search />} label="Formula help" onClick={() => props.onStatus("Begin a formula with =. Cell ranges use A1:A10 notation.")} /></> : null}
  </div>;
  return <div className="spreadsheet-ribbon">
    <div className="spreadsheet-ribbon-group"><button onClick={() => props.onStatus("Undo history is not available.")} title="Undo"><Undo2 /></button><button onClick={() => props.onStatus("Redo history is not available.")} title="Redo"><Redo2 /></button><button onClick={props.onImport} title="Open .xlsx"><Upload /></button><small>File</small></div>
    <div className="spreadsheet-ribbon-group spreadsheet-font-group"><select aria-label="Font family" defaultValue="Aptos"><option>Aptos</option><option>Arial</option><option>Calibri</option><option>Georgia</option></select><select aria-label="Font size" defaultValue="11"><option>9</option><option>10</option><option>11</option><option>12</option><option>14</option><option>18</option><option>24</option></select><span><button className={props.style.bold ? "active" : ""} onClick={() => props.onToggle("bold")} title="Bold"><Bold /></button><button className={props.style.italic ? "active" : ""} onClick={() => props.onToggle("italic")} title="Italic"><Italic /></button><button className={props.style.underline ? "active" : ""} onClick={() => props.onToggle("underline")} title="Underline"><Underline /></button><label title="Fill colour"><PaintBucket /><input type="color" value={props.style.fillColor || "#ffffff"} onChange={(event) => props.onStyle({ fillColor: event.target.value })} /></label><label title="Text colour"><b>A</b><input type="color" value={props.style.textColor || "#000000"} onChange={(event) => props.onStyle({ textColor: event.target.value })} /></label></span><small>Font</small></div>
    <div className="spreadsheet-ribbon-group"><span><button className={props.style.align === "left" ? "active" : ""} onClick={() => props.onStyle({ align: "left" })} title="Align left"><AlignLeft /></button><button className={props.style.align === "center" ? "active" : ""} onClick={() => props.onStyle({ align: "center" })} title="Align centre"><AlignCenter /></button><button className={props.style.align === "right" ? "active" : ""} onClick={() => props.onStyle({ align: "right" })} title="Align right"><AlignRight /></button></span><small>Alignment</small></div>
    <div className="spreadsheet-ribbon-group spreadsheet-number-group"><select aria-label="Number format" value={props.style.numberFormat || "General"} onChange={(event) => props.onStyle({ numberFormat: event.target.value === "General" ? undefined : event.target.value })}><option>General</option><option value="0">Number</option><option value="0.00">Number (2 decimals)</option><option value="0%">Percentage</option><option value="0.00%">Percentage (2 decimals)</option><option value="$#,##0.00">Currency ($)</option><option value="£#,##0.00">Currency (£)</option><option value="€#,##0.00">Currency (€)</option></select><span><button onClick={() => props.onStyle({ numberFormat: "$#,##0.00" })} title="Currency">$</button><button onClick={() => props.onStyle({ numberFormat: "0%" })} title="Percent"><Percent /></button></span><small>Number</small></div>
    <div className="spreadsheet-ribbon-group"><RibbonButton icon={<Sigma />} label="AutoSum" onClick={() => props.onStatus("Enter =SUM(A1:A10) in the selected cell.")} /><RibbonButton icon={<Download />} label="Export" onClick={props.onExport} /><RibbonButton icon={<Trash2 />} label="Delete file" onClick={props.onDelete} /></div>
  </div>;
}

function RibbonButton(props: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className="spreadsheet-ribbon-button" onClick={props.onClick}>{props.icon}<span>{props.label}</span></button>;
}

function cellStyle(cell: SpreadsheetCell | undefined): CSSProperties {
  return {
    fontWeight: cell?.style?.bold ? 700 : 400,
    fontStyle: cell?.style?.italic ? "italic" : "normal",
    textDecoration: cell?.style?.underline ? "underline" : "none",
    color: cell?.style?.textColor,
    backgroundColor: cell?.style?.fillColor,
    textAlign: cell?.style?.align,
  };
}

function createBudgetWorkbook(): WorkbookData {
  const id = crypto.randomUUID();
  return { activeSheetId: id, sheets: [{ id, name: "Monthly budget", cells: {
    A1: { value: "Monthly budget", style: { bold: true, fillColor: "#e2f0d9" } },
    A3: { value: "Category", style: { bold: true } }, B3: { value: "Budget", style: { bold: true } }, C3: { value: "Actual", style: { bold: true } }, D3: { value: "Difference", style: { bold: true } },
    A4: { value: "Income" }, B4: { value: 0, style: { numberFormat: "£#,##0.00" } }, C4: { value: 0, style: { numberFormat: "£#,##0.00" } }, D4: { value: null, formula: "=C4-B4", style: { numberFormat: "£#,##0.00" } },
    A5: { value: "Housing" }, B5: { value: 0, style: { numberFormat: "£#,##0.00" } }, C5: { value: 0, style: { numberFormat: "£#,##0.00" } }, D5: { value: null, formula: "=B5-C5", style: { numberFormat: "£#,##0.00" } },
    A6: { value: "Food" }, B6: { value: 0, style: { numberFormat: "£#,##0.00" } }, C6: { value: 0, style: { numberFormat: "£#,##0.00" } }, D6: { value: null, formula: "=B6-C6", style: { numberFormat: "£#,##0.00" } },
    A8: { value: "Balance", style: { bold: true } }, C8: { value: null, formula: "=C4-SUM(C5:C6)", style: { bold: true, numberFormat: "£#,##0.00" } },
  } }] };
}

function createProjectWorkbook(): WorkbookData {
  const id = crypto.randomUUID();
  return { activeSheetId: id, sheets: [{ id, name: "Tracker", cells: {
    A1: { value: "Task", style: { bold: true, fillColor: "#e2f0d9" } }, B1: { value: "Owner", style: { bold: true, fillColor: "#e2f0d9" } }, C1: { value: "Due", style: { bold: true, fillColor: "#e2f0d9" } }, D1: { value: "Status", style: { bold: true, fillColor: "#e2f0d9" } },
    A2: { value: "Define scope" }, B2: { value: "" }, C2: { value: "" }, D2: { value: "Not started" },
    A3: { value: "Build" }, B3: { value: "" }, C3: { value: "" }, D3: { value: "Not started" },
    A4: { value: "Review" }, B4: { value: "" }, C4: { value: "" }, D4: { value: "Not started" },
  } }] };
}

function titleCase(value: string): string { return value.split(" ").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" "); }
function relativeDate(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(new Date(value));
}
