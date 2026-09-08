import DOMPurify from "dompurify";
import {
  AArrowDown,
  AArrowUp,
  Activity,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  BookOpen,
  Bold,
  CaseUpper,
  Check,
  ChevronDown,
  ClipboardPaste,
  Cloud,
  Columns3,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Grid3X3,
  Highlighter,
  HelpCircle,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  ListTodo,
  ListTree,
  LogOut,
  Mail,
  Maximize2,
  MessageSquareText,
  Mic,
  Minus,
  Moon,
  Paintbrush,
  PanelLeft,
  PanelLeftClose,
  Pilcrow,
  Printer,
  Puzzle,
  Redo2,
  RemoveFormatting,
  Rows3,
  Save,
  Search,
  Scissors,
  Settings,
  Share2,
  SpellCheck2,
  Sparkles,
  Strikethrough,
  Subscript,
  Sun,
  Superscript,
  Table,
  Trash2,
  Underline,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ClipboardEvent, CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRecord, DocumentPageSettings, DocumentRecord, DocumentSummary } from "../shared/types";
import { isDocumentAttachment, MAX_DOCUMENT_IMPORT_BYTES, documentImportFilename } from "../shared/documentAttachments";
import { mailApi } from "./api";
import { hydrateDocumentStyles, serializeDocumentStyle } from "./documentStyle";
import "./document.css";

type RibbonTab = "home" | "insert" | "layout" | "references" | "review" | "view" | "help";
type SaveState = "saved" | "saving" | "unsaved" | "error";
type TemplateCategory = "Recommended" | "Work" | "Education" | "Personal";
type DocumentSort = "updated" | "title" | "words";
type NavigationTab = "pages" | "headings";
type DocumentNavigation = {
  pages: string[];
  headings: Array<{ index: number; label: string; level: number; page: number }>;
};

const DEFAULT_PAGE: DocumentPageSettings = { size: "letter", orientation: "portrait", margins: "normal" };
const EMPTY_DOCUMENT = "<p><br></p>";
const templateCategories: TemplateCategory[] = ["Recommended", "Work", "Education", "Personal"];
const templates = [
  { name: "Blank document", description: "Start with a clean page", category: "Recommended" as const, icon: FilePlus2, html: EMPTY_DOCUMENT },
  { name: "Meeting notes", description: "Agenda, notes, and actions", category: "Work" as const, icon: List, html: "<h1>Meeting notes</h1><p><strong>Date:</strong> </p><p><strong>Attendees:</strong> </p><h2>Agenda</h2><ol><li><br></li></ol><h2>Notes</h2><p><br></p><h2>Action items</h2><ul><li><br></li></ul>" },
  { name: "Business letter", description: "A polished letter layout", category: "Work" as const, icon: Mail, html: "<p>[Your name]<br>[Address]<br>[City, postcode]</p><p>[Date]</p><p>[Recipient name]<br>[Company]<br>[Address]</p><p>Dear [Name],</p><p><br></p><p>Yours sincerely,</p><p>[Your name]</p>" },
  { name: "Project brief", description: "Frame a project clearly", category: "Work" as const, icon: FileText, html: "<h1>Project brief</h1><p><strong>Owner:</strong> </p><p><strong>Status:</strong> Draft</p><h2>Overview</h2><p><br></p><h2>Goals</h2><ul><li><br></li></ul><h2>Scope</h2><p><br></p><h2>Milestones</h2><ol><li><br></li></ol>" },
  { name: "Modern résumé", description: "Skills and experience at a glance", category: "Personal" as const, icon: FileText, html: "<h1>[Your name]</h1><p>[Email] · [Phone] · [Location]</p><h2>Profile</h2><p>Write a short professional summary.</p><h2>Experience</h2><p><strong>[Role]</strong> — [Organisation]</p><p>[Dates]</p><ul><li>Describe an achievement.</li></ul><h2>Skills</h2><p>[Skill] · [Skill] · [Skill]</p>" },
  { name: "Student report", description: "Structured academic report", category: "Education" as const, icon: BookOpen, html: "<h1>[Report title]</h1><p><strong>Student:</strong> [Name]</p><p><strong>Course:</strong> [Course]</p><h2>Introduction</h2><p><br></p><h2>Findings</h2><p><br></p><h2>Conclusion</h2><p><br></p><h2>References</h2><ol><li><br></li></ol>" },
  { name: "Service invoice", description: "Simple client invoice", category: "Work" as const, icon: Grid3X3, html: "<h1>INVOICE</h1><p><strong>From:</strong> [Your business]</p><p><strong>Bill to:</strong> [Client]</p><p><strong>Invoice date:</strong> [Date]</p><table><tbody><tr><th>Description</th><th>Quantity</th><th>Rate</th><th>Amount</th></tr><tr><td>[Service]</td><td>1</td><td>£0.00</td><td>£0.00</td></tr></tbody></table><p><strong>Total: £0.00</strong></p>" },
  { name: "Personal journal", description: "Reflect, plan, and capture ideas", category: "Personal" as const, icon: BookOpen, html: "<h1>Journal</h1><p><strong>Date:</strong> </p><h2>Today</h2><p><br></p><h2>What I learned</h2><p><br></p><h2>Tomorrow</h2><ul><li><br></li></ul>" },
];

export function DocumentApp(props: {
  userEmail: string;
  initialAttachment?: AttachmentRecord | null;
  onInitialAttachmentHandled?: () => void;
  onExit: () => void;
  onLogout: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [activeDocument, setActiveDocument] = useState<DocumentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [zoom, setZoom] = useState(100);
  const [focusMode, setFocusMode] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [spellcheck, setSpellcheck] = useState(true);
  const [showFormattingMarks, setShowFormattingMarks] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationTab, setNavigationTab] = useState<NavigationTab>("pages");
  const [navigation, setNavigation] = useState<DocumentNavigation>({ pages: [], headings: [] });
  const [templateCategory, setTemplateCategory] = useState<TemplateCategory>("Recommended");
  const [templateQuery, setTemplateQuery] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [documentSort, setDocumentSort] = useState<DocumentSort>("updated");
  const [darkMode, setDarkMode] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const editorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const toolSearchRef = useRef<HTMLInputElement>(null);
  const paginationTimerRef = useRef<number | undefined>(undefined);
  const revisionRef = useRef(0);
  const initialAttachmentRef = useRef<string | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      setDocuments((await mailApi.documents()).documents);
    } catch {
      setStatus("Documents could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadDocuments(), [loadDocuments]);

  useEffect(() => {
    const attachment = props.initialAttachment;
    if (!attachment || initialAttachmentRef.current === attachment.id) return;
    initialAttachmentRef.current = attachment.id;
    void openMailAttachment(attachment).finally(() => props.onInitialAttachmentHandled?.());
  }, [props.initialAttachment?.id]);

  useEffect(() => {
    if (!activeDocument || !editorRef.current) return;
    setPageCount(setDocumentHtml(editorRef.current, activeDocument.contentHtml, activeDocument.page));
    setNavigation(readDocumentNavigation(editorRef.current));
    setCurrentPage(1);
    editorRef.current.focus();
  }, [activeDocument?.id]);

  useEffect(() => {
    if (!activeDocument || !editorRef.current) return;
    setPageCount(paginateDocument(editorRef.current, activeDocument.page));
    setNavigation(readDocumentNavigation(editorRef.current));
    setCurrentPage(1);
  }, [activeDocument?.page.size, activeDocument?.page.orientation, activeDocument?.page.margins]);

  useEffect(() => () => {
    if (paginationTimerRef.current !== undefined) window.clearTimeout(paginationTimerRef.current);
  }, []);

  const saveNow = useCallback(async (record: DocumentRecord, revision = revisionRef.current) => {
    setSaveState("saving");
    try {
      const contentHtml = sanitizeDocumentHtml(record.contentHtml);
      const result = await mailApi.saveDocument(record.id, {
        title: record.title.trim() || "Untitled document",
        contentHtml,
        plainText: record.plainText,
        page: record.page,
      });
      if (revision === revisionRef.current) {
        setDirty(false);
        setSaveState("saved");
        setActiveDocument((current) => current?.id === record.id ? { ...current, contentHtml, updatedAt: result.updatedAt } : current);
      }
    } catch {
      setSaveState("error");
      setStatus("This document could not be saved. Your changes are still in the editor.");
    }
  }, []);

  useEffect(() => {
    if (!activeDocument || !dirty) return;
    const revision = revisionRef.current;
    const timeout = window.setTimeout(() => void saveNow(activeDocument, revision), 900);
    return () => window.clearTimeout(timeout);
  }, [activeDocument, dirty, saveNow]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (!activeDocument || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void saveNow(activeDocument);
      } else if (key === "f") {
        event.preventDefault();
        setShowFind(true);
      } else if (key === "h") {
        event.preventDefault();
        setShowFind(true);
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
  }, [activeDocument, saveNow]);

  function markChanged(next: Partial<DocumentRecord>) {
    revisionRef.current += 1;
    setDirty(true);
    setSaveState("unsaved");
    setActiveDocument((current) => current ? { ...current, ...next } : current);
  }

  function syncEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    markChanged({ contentHtml: serializeEditorHtml(editor), plainText: editor.innerText.replace(/\u00a0/g, " ") });
    if (paginationTimerRef.current !== undefined) window.clearTimeout(paginationTimerRef.current);
    paginationTimerRef.current = window.setTimeout(() => {
      if (!editorRef.current || !activeDocument) return;
      setPageCount(paginateDocument(editorRef.current, activeDocument.page));
      setNavigation(readDocumentNavigation(editorRef.current));
    }, 240);
  }

  function command(name: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(name, false, value);
    syncEditor();
  }

  function applyBlockStyle(property: "line-height" | "background-color", value: string) {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode) return;
    const anchor = selection.anchorNode instanceof HTMLElement ? selection.anchorNode : selection.anchorNode.parentElement;
    const block = anchor?.closest<HTMLElement>("p,div,li,h1,h2,h3,h4,h5,h6,blockquote");
    if (!block || !editor.contains(block)) {
      setStatus("Place the cursor in a paragraph first.");
      return;
    }
    block.style.setProperty(property, value);
    syncEditor();
  }

  function changeSelectionCase() {
    const selection = window.getSelection();
    const selectedText = selection?.toString() || "";
    if (!selectedText) {
      setStatus("Select text before changing its case.");
      return;
    }
    document.execCommand("insertText", false, selectedText === selectedText.toUpperCase() ? selectedText.toLowerCase() : selectedText.toUpperCase());
    syncEditor();
  }

  function scrollToPage(page: number) {
    const pageElement = editorRef.current?.querySelector<HTMLElement>(`:scope > .document-page:nth-child(${page})`);
    if (!pageElement) return;
    pageElement.scrollIntoView({ block: "start", behavior: "smooth" });
    setCurrentPage(page);
  }

  function scrollToHeading(index: number, page: number) {
    const heading = editorRef.current?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")[index];
    if (!heading) return;
    heading.scrollIntoView({ block: "center", behavior: "smooth" });
    setCurrentPage(page);
  }

  function updateCurrentPage() {
    const canvas = canvasRef.current;
    const pages = Array.from(editorRef.current?.querySelectorAll<HTMLElement>(":scope > .document-page") || []);
    if (!canvas || !pages.length) return;
    const canvasTop = canvas.getBoundingClientRect().top + 18;
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    pages.forEach((page, index) => {
      const nextDistance = Math.abs(page.getBoundingClientRect().top - canvasTop);
      if (nextDistance < distance) {
        closest = index;
        distance = nextDistance;
      }
    });
    setCurrentPage(closest + 1);
  }

  async function createDocument(template = templates[0]) {
    setOpening(true);
    setStatus("");
    try {
      const title = template.name === "Blank document" ? "Untitled document" : template.name;
      const result = await mailApi.createDocument({
        title,
        contentHtml: template.html,
        plainText: htmlToPlainText(template.html),
        page: DEFAULT_PAGE,
      });
      revisionRef.current = 0;
      setDirty(false);
      setSaveState("saved");
      setActiveDocument(result.document);
    } catch {
      setStatus("A new document could not be created.");
    } finally {
      setOpening(false);
    }
  }

  async function openDocument(id: string): Promise<boolean> {
    setOpening(true);
    setStatus("");
    try {
      const result = await mailApi.document(id);
      revisionRef.current = 0;
      setDirty(false);
      setSaveState("saved");
      setActiveDocument({ ...result.document, contentHtml: sanitizeDocumentHtml(result.document.contentHtml) });
      return true;
    } catch {
      setStatus("That document could not be opened.");
      return false;
    } finally {
      setOpening(false);
    }
  }

  async function returnToDocuments() {
    if (activeDocument && dirty) await saveNow(activeDocument);
    setActiveDocument(null);
    await loadDocuments();
  }

  async function openMailAttachment(attachment: AttachmentRecord): Promise<void> {
    if (!isDocumentAttachment(attachment)) {
      setStatus("Only .docx attachments can be opened here.");
      return;
    }
    if (attachment.sizeBytes > MAX_DOCUMENT_IMPORT_BYTES) {
      setStatus("That attachment is larger than the 15 MB document import limit. Download the original from Mail instead.");
      return;
    }
    setOpening(true);
    setStatus(`Opening ${attachment.filename} from Mail…`);
    try {
      const linked = await mailApi.documentForAttachment(attachment.id);
      if (linked.documentId) {
        const opened = await openDocument(linked.documentId);
        if (opened) setStatus("Opened the existing editable copy. The original mail attachment is unchanged.");
        return;
      }
      const importName = documentImportFilename(linked.attachment.filename);
      const file = await mailApi.attachmentFile(linked.attachment, importName);
      await importDocx(file, attachment.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That mail attachment could not be opened in document.");
    } finally {
      setOpening(false);
    }
  }

  async function importDocx(file: File | undefined, sourceAttachmentId: string | null = null): Promise<boolean> {
    if (!file) return false;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setStatus("Choose a .docx file.");
      return false;
    }
    if (file.size > MAX_DOCUMENT_IMPORT_BYTES) {
      setStatus("That document is larger than the 15 MB import limit.");
      return false;
    }
    setOpening(true);
    setStatus("Importing document…");
    try {
      const arrayBuffer = await file.arrayBuffer();
      let imported: { html: string; plainText: string; page: DocumentPageSettings; warnings: string[] };
      try {
        imported = await (await import("./docxImport")).importDocxRich(arrayBuffer);
      } catch {
        const mammoth = (await import("mammoth")).default;
        const converted = await mammoth.convertToHtml(
          { arrayBuffer },
          { convertImage: mammoth.images.dataUri, styleMap: ["p[style-name='Title'] => h1:fresh"] },
        );
        const html = converted.value || EMPTY_DOCUMENT;
        imported = { html, plainText: htmlToPlainText(html), page: DEFAULT_PAGE, warnings: converted.messages.map((message) => message.message) };
      }
      const contentHtml = sanitizeDocumentHtml(imported.html);
      const result = await mailApi.createDocument({
        title: file.name.replace(/\.docx$/i, "") || "Imported document",
        contentHtml,
        plainText: imported.plainText || htmlToPlainText(contentHtml),
        page: imported.page,
        sourceAttachmentId,
      });
      revisionRef.current = 0;
      setDirty(false);
      setSaveState("saved");
      setActiveDocument(result.document);
      setStatus(sourceAttachmentId
        ? result.reused
          ? "Opened the existing editable copy. The original mail attachment is unchanged."
          : imported.warnings.length
            ? `Opened from Mail with ${imported.warnings.length} compatibility note${imported.warnings.length === 1 ? "" : "s"}. The original attachment is unchanged.`
            : "Opened an editable copy from Mail with document formatting. The original attachment is unchanged."
        : imported.warnings.length
          ? `Imported with ${imported.warnings.length} compatibility note${imported.warnings.length === 1 ? "" : "s"}.`
          : "Document imported with document formatting.");
      return true;
    } catch {
      setStatus("The .docx file could not be imported.");
      return false;
    } finally {
      setOpening(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function downloadDocument() {
    if (!activeDocument) return;
    setStatus("Preparing document…");
    try {
      const { exportDocx } = await import("./docx");
      await exportDocx(activeDocument.title, sanitizeDocumentHtml(activeDocument.contentHtml), activeDocument.page);
      setStatus("Downloaded a .docx copy.");
    } catch {
      setStatus("The .docx download could not be created.");
    }
  }

  async function deleteDocument() {
    if (!activeDocument || !window.confirm(`Move “${activeDocument.title}” out of your document list?`)) return;
    try {
      await mailApi.deleteDocument(activeDocument.id);
      setActiveDocument(null);
      setStatus("Document removed.");
      await loadDocuments();
    } catch {
      setStatus("The document could not be removed.");
    }
  }

  function insertLink() {
    const url = window.prompt("Paste a link address");
    if (!url) return;
    try {
      const normalized = new URL(url, window.location.origin);
      if (!["http:", "https:", "mailto:"].includes(normalized.protocol)) throw new Error("Unsupported protocol");
      command("createLink", normalized.href);
    } catch {
      setStatus("Use an http, https, or mailto link.");
    }
  }

  function insertTable() {
    const cells = Array.from({ length: 3 }, () => "<td><br></td>").join("");
    command("insertHTML", `<table><tbody>${Array.from({ length: 3 }, () => `<tr>${cells}</tr>`).join("")}</tbody></table><p><br></p>`);
  }

  function insertImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 1_000_000) {
      setStatus("Choose an image smaller than 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      command("insertHTML", `<img src="${reader.result}" alt="${escapeHtml(file.name)}"><p><br></p>`);
      if (imageRef.current) imageRef.current.value = "";
    };
    reader.readAsDataURL(file);
  }

  function findNext() {
    if (!findText) return;
    const browserFind = (window as Window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean) => boolean }).find;
    const found = browserFind?.(findText, false, false, true);
    setStatus(found === false ? `“${findText}” was not found.` : "");
  }

  function replaceAll() {
    const editor = editorRef.current;
    if (!editor || !findText) return;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current as Text);
      current = walker.nextNode();
    }
    const expression = new RegExp(escapeRegExp(findText), "gi");
    let count = 0;
    nodes.forEach((node) => {
      const value = node.data;
      const matches = value.match(expression)?.length || 0;
      if (matches) {
        node.data = value.replace(expression, replaceText);
        count += matches;
      }
    });
    if (count) syncEditor();
    setStatus(count ? `Replaced ${count} match${count === 1 ? "" : "es"}.` : `“${findText}” was not found.`);
  }

  function runToolSearch(value: string) {
    const query = value.trim().toLowerCase();
    if (!query) return;
    if (query.includes("find") || query.includes("replace")) {
      setShowFind(true);
      setStatus("Find and replace opened.");
    } else if (query.includes("download") || query.includes("export") || query.includes("share")) {
      void downloadDocument();
    } else if (query.includes("print")) {
      window.print();
    } else if (query.includes("table")) {
      insertTable();
    } else if (query.includes("picture") || query.includes("image")) {
      imageRef.current?.click();
    } else if (query.includes("spell") || query.includes("editor")) {
      setSpellcheck(true);
      setActiveTab("review");
      setStatus("Editor spelling suggestions are on.");
    } else if (query.includes("focus")) {
      setFocusMode(true);
    } else if (query.includes("navigation") || query.includes("heading") || query.includes("page")) {
      setNavigationOpen(true);
      setNavigationTab(query.includes("heading") ? "headings" : "pages");
      setStatus("Document navigation opened.");
    } else if (query.includes("paragraph mark") || query.includes("formatting mark")) {
      setShowFormattingMarks(true);
      setStatus("Formatting marks are showing.");
    } else {
      setStatus(`No matching tool for “${value.trim()}”. Try find, table, navigation, print, download, spelling, or focus.`);
    }
  }

  const normalizedTemplateQuery = templateQuery.trim().toLowerCase();
  const visibleTemplates = templates.filter((template) => {
    const categoryMatches = templateCategory === "Recommended" || template.category === templateCategory || template.category === "Recommended";
    const queryMatches = !normalizedTemplateQuery || `${template.name} ${template.description} ${template.category}`.toLowerCase().includes(normalizedTemplateQuery);
    return categoryMatches && queryMatches;
  });
  const normalizedDocumentQuery = documentQuery.trim().toLowerCase();
  const visibleDocuments = documents
    .filter((record) => !normalizedDocumentQuery || `${record.title} ${record.preview}`.toLowerCase().includes(normalizedDocumentQuery))
    .slice()
    .sort((left, right) => documentSort === "title"
      ? left.title.localeCompare(right.title)
      : documentSort === "words"
        ? right.wordCount - left.wordCount
        : new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf());

  if (!activeDocument) {
    return (
      <div className="document-app document-start">
        <DocumentStartHeader userEmail={props.userEmail} onExit={props.onExit} onLogout={props.onLogout} />
        <main className="document-start-main">
          <section className="document-start-hero">
            <div><p className="document-kicker">cfmail Documents</p><h1>Welcome back</h1><p>Create, edit, import, and export documents.</p></div>
            <div className="document-quick-actions" aria-label="Quick actions">
              <button className="primary" onClick={() => void createDocument()} disabled={opening}><FilePlus2 /> Blank document</button>
              <button onClick={() => importRef.current?.click()}><Upload /> Upload a file</button>
            </div>
          </section>
          <section className="document-template-discovery" aria-labelledby="document-template-heading">
            <div className="document-template-heading"><div><p className="document-kicker">Create new</p><h2 id="document-template-heading">Create with templates</h2></div><label className="document-template-search"><Search /><span className="sr-only">Search templates</span><input value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder="Search templates" /></label></div>
            <div className="document-template-tabs" role="tablist" aria-label="Template categories">{templateCategories.map((category) => <button key={category} role="tab" aria-selected={templateCategory === category} className={templateCategory === category ? "active" : ""} onClick={() => setTemplateCategory(category)}>{category}</button>)}</div>
            <div className="document-template-grid" aria-label="Document templates">{visibleTemplates.map((template) => {
              const Icon = template.icon;
              return <button key={template.name} onClick={() => void createDocument(template)} disabled={opening}><span className="document-template-page"><Icon /></span><strong>{template.name}</strong><small>{template.description}</small></button>;
            })}</div>
            {!visibleTemplates.length ? <p className="document-template-empty">No templates match “{templateQuery}”.</p> : null}
          </section>
          <section className="document-recent" aria-labelledby="recent-documents-heading">
            <div className="document-section-heading"><div><p className="document-kicker">Your files</p><h2 id="recent-documents-heading">My documents</h2></div><button onClick={() => void loadDocuments()}>Refresh</button></div>
            <div className="document-list-tools"><label><Search /><span className="sr-only">Filter documents</span><input value={documentQuery} onChange={(event) => setDocumentQuery(event.target.value)} placeholder="Filter by name or content" /></label><label><span>Sort</span><select value={documentSort} onChange={(event) => setDocumentSort(event.target.value as DocumentSort)}><option value="updated">Last opened</option><option value="title">Name</option><option value="words">Word count</option></select></label></div>
            {loading ? <div className="document-loading"><span /> Loading documents…</div> : null}
            {!loading && !documents.length ? <div className="document-empty"><FileText /><h3>No documents yet</h3><p>Choose a template above or import a .docx file.</p></div> : null}
            {!loading && documents.length > 0 && !visibleDocuments.length ? <div className="document-empty"><Search /><h3>No matching documents</h3><p>Try a different name or keyword.</p></div> : null}
            <div className="document-document-list">
              {visibleDocuments.map((record) => <button key={record.id} onClick={() => void openDocument(record.id)} disabled={opening}>
                <span className="document-file-icon"><FileText /></span>
                <span className="document-document-meta"><strong>{record.title}</strong><small>{record.preview || "Blank document"}</small></span>
                <span className="document-document-stats"><time>{relativeDocumentDate(record.updatedAt)}</time><small>{record.wordCount.toLocaleString()} words</small></span>
              </button>)}
            </div>
          </section>
          {status ? <p className="document-start-status" role="status">{status}</p> : null}
        </main>
        <input ref={importRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => void importDocx(event.target.files?.[0])} />
      </div>
    );
  }

  const words = wordCount(activeDocument.plainText);
  const pageStyle = { "--document-zoom": zoom / 100 } as CSSProperties;
  return (
    <div className={`document-app document-editor-shell ${focusMode ? "focus-mode" : ""} ${showFormattingMarks ? "show-formatting-marks" : ""} ${darkMode ? "dark-mode" : "light-mode"}`}>
      <header className="document-titlebar">
        <button className="document-app-launcher" onClick={() => setStatus("cfmail apps: Mail, Calendar, Documents, and Spreadsheets.")} title="App launcher" aria-label="App launcher"><Grid3X3 /></button>
        <button className="document-brand-icon" onClick={() => void returnToDocuments()} title="Documents home" aria-label="cfmail Documents home">D</button>
        <div className="document-title-area">
          <label className="sr-only" htmlFor="document-title">Document title</label>
          <input id="document-title" value={activeDocument.title} onChange={(event) => markChanged({ title: event.target.value })} onBlur={() => activeDocument && void saveNow(activeDocument)} />
          <span className={`document-save-state ${saveState}`} aria-live="polite" title={saveState === "saved" ? "Saved to cfmail" : undefined}>{saveState === "saving" ? <Cloud /> : saveState === "saved" ? <Check /> : saveState === "error" ? <Cloud /> : <Save />}{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Unsaved"}</span>
        </div>
        <label className="document-tool-search"><Search /><span className="sr-only">Search tools and help</span><input ref={toolSearchRef} placeholder="Search for tools, help, and more (Option + Q)" onKeyDown={(event) => { if (event.key === "Enter") runToolSearch(event.currentTarget.value); }} /></label>
        <button className="document-private-badge" onClick={() => setStatus("Private cfmail workspace. Documents are scoped to your Access identity.")}>cfmail</button>
        <button className="document-title-icon" onClick={() => setStatus("Document settings are available from the ribbon and status bar.")} aria-label="Settings"><Settings /></button>
        <button className="document-user" onClick={props.onLogout} title="Sign out"><span>{props.userEmail.slice(0, 1).toUpperCase()}</span><LogOut /></button>
      </header>

      <div className="document-commandbar">
        <nav className="document-tabs" aria-label="Document ribbon">
          <button onClick={() => void returnToDocuments()}>File</button>
          {(["home", "insert", "layout", "references", "review", "view", "help"] as RibbonTab[]).map((tab) => <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>{tab.slice(0, 1).toUpperCase() + tab.slice(1)}</button>)}
        </nav>
        <div className="document-document-actions">
          <button onClick={() => setStatus("Comments and suggestions are not available.")}><MessageSquareText /> Comments</button>
          <button onClick={() => setStatus(saveState === "saved" ? "You’re caught up. All changes are saved." : "This document still has unsaved changes.")}><Activity /> Catch up</button>
          <button onClick={() => setStatus("Editing mode is active.")}><Paintbrush /> Editing <ChevronDown /></button>
          <button className="primary" onClick={() => void downloadDocument()}><Share2 /> Share <ChevronDown /></button>
        </div>
      </div>

      <Ribbon
        tab={activeTab}
        page={activeDocument.page}
        zoom={zoom}
        spellcheck={spellcheck}
        onCommand={command}
        onBlockStyle={applyBlockStyle}
        onChangeCase={changeSelectionCase}
        onPage={(page) => markChanged({ page })}
        onZoom={setZoom}
        onSpellcheck={setSpellcheck}
        onFind={() => setShowFind(true)}
        onInsertLink={insertLink}
        onInsertTable={insertTable}
        onInsertImage={() => imageRef.current?.click()}
        onDownload={() => void downloadDocument()}
        onPrint={() => window.print()}
        onDelete={() => void deleteDocument()}
        onFocus={() => setFocusMode((value) => !value)}
        onFormattingMarks={() => setShowFormattingMarks((value) => !value)}
        onStatus={setStatus}
        focusMode={focusMode}
        showFormattingMarks={showFormattingMarks}
        words={words}
      />
      {focusMode ? <button className="document-focus-exit" onClick={() => setFocusMode(false)}>Exit focus mode</button> : null}

      {showFind ? <div className="document-find-panel">
        <label>Find<input autoFocus value={findText} onChange={(event) => setFindText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && findNext()} /></label>
        <label>Replace with<input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} /></label>
        <button onClick={findNext}>Find next</button><button onClick={replaceAll}>Replace all</button><button className="document-find-close" onClick={() => setShowFind(false)} aria-label="Close find and replace">×</button>
      </div> : null}

      <div className="document-workspace">
        <aside className={`document-navigation ${navigationOpen ? "open" : ""}`} aria-label="Document navigation">
          <div className="document-navigation-rail">
            <button className={navigationOpen && navigationTab === "pages" ? "active" : ""} title="Page thumbnails" aria-label="Page thumbnails" onClick={() => { setNavigationTab("pages"); setNavigationOpen((open) => navigationTab !== "pages" || !open); }}><PanelLeft /></button>
            <button className={navigationOpen && navigationTab === "headings" ? "active" : ""} title="Headings" aria-label="Headings" onClick={() => { setNavigationTab("headings"); setNavigationOpen((open) => navigationTab !== "headings" || !open); }}><ListTree /></button>
          </div>
          {navigationOpen ? <section className="document-navigation-panel">
            <header><strong>Navigation</strong><button onClick={() => setNavigationOpen(false)} aria-label="Close navigation"><PanelLeftClose /></button></header>
            <div className="document-navigation-tabs" role="tablist"><button role="tab" aria-selected={navigationTab === "pages"} className={navigationTab === "pages" ? "active" : ""} onClick={() => setNavigationTab("pages")}>Pages</button><button role="tab" aria-selected={navigationTab === "headings"} className={navigationTab === "headings" ? "active" : ""} onClick={() => setNavigationTab("headings")}>Headings</button></div>
            {navigationTab === "pages" ? <div className="document-page-list">{navigation.pages.map((preview, index) => <button key={index} className={currentPage === index + 1 ? "active" : ""} onClick={() => scrollToPage(index + 1)}><span className="document-page-miniature"><FileText /></span><span><strong>Page {index + 1}</strong><small>{preview || "Blank page"}</small></span></button>)}</div> : <div className="document-heading-list">{navigation.headings.length ? navigation.headings.map((heading) => <button key={`${heading.index}-${heading.label}`} style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }} onClick={() => scrollToHeading(heading.index, heading.page)}><span>{heading.label}</span><small>Page {heading.page}</small></button>) : <p>Add heading styles to build document navigation.</p>}</div>}
          </section> : null}
        </aside>
        <main ref={canvasRef} className="document-canvas" aria-label="Document editor" onScroll={updateCurrentPage}>
          <div
            ref={editorRef}
            className="document-pages"
            style={pageStyle}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spellcheck}
            role="textbox"
            aria-multiline="true"
            aria-label={`${activeDocument.title} document body`}
            onInput={syncEditor}
            onPaste={(event) => pasteCleanly(event, syncEditor)}
          />
        </main>
      </div>

      <footer className="document-statusbar">
        <button className="document-status-item" onClick={() => { setNavigationTab("pages"); setNavigationOpen(true); }}>Page {currentPage} of {pageCount}</button><button className="document-status-item">{words.toLocaleString()} word{words === 1 ? "" : "s"}</button><button className="document-status-item">English (U.K.)</button><button className="document-status-item">{spellcheck ? "Editor Suggestions: Showing" : "Editor Suggestions: Hidden"}</button>
        <span className="document-status-spacer" />
        <button className="document-page-view active" title="Separate pages" aria-label="Separate pages"><Columns3 /></button>
        <button onClick={() => setZoom((value) => Math.max(50, value - 10))} aria-label="Zoom out"><ZoomOut /></button>
        <input aria-label="Document zoom" type="range" min="50" max="180" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
        <button onClick={() => setZoom((value) => Math.min(180, value + 10))} aria-label="Zoom in"><ZoomIn /></button>
        <span>{zoom}%</span>
        <button onClick={() => setZoom(100)} aria-label="Fit page width"><Maximize2 /></button><span className="document-fit-label">Fit</span>
        <button onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? "Switch to light background" : "Switch to dark background"}>{darkMode ? <Sun /> : <Moon />}</button>
      </footer>
      <div className="document-live-status" aria-live="polite">{status}</div>
      <input ref={importRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => void importDocx(event.target.files?.[0])} />
      <input ref={imageRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => insertImage(event.target.files?.[0])} />
    </div>
  );
}

function DocumentStartHeader(props: { userEmail: string; onExit: () => void; onLogout: () => void }) {
  return <header className="document-start-header"><button className="document-mail-link" onClick={props.onExit}><Mail /> Mail</button><span className="document-brand-icon">D</span><strong>cfmail Documents</strong><span className="document-start-header-spacer" /><span className="document-start-email">{props.userEmail}</span><button className="document-user" onClick={props.onLogout} title="Sign out"><span>{props.userEmail.slice(0, 1).toUpperCase()}</span><LogOut /></button></header>;
}

function Ribbon(props: {
  tab: RibbonTab;
  page: DocumentPageSettings;
  zoom: number;
  spellcheck: boolean;
  words: number;
  focusMode: boolean;
  showFormattingMarks: boolean;
  onCommand: (name: string, value?: string) => void;
  onBlockStyle: (property: "line-height" | "background-color", value: string) => void;
  onChangeCase: () => void;
  onPage: (page: DocumentPageSettings) => void;
  onZoom: (zoom: number) => void;
  onSpellcheck: (value: boolean) => void;
  onFind: () => void;
  onInsertLink: () => void;
  onInsertTable: () => void;
  onInsertImage: () => void;
  onDownload: () => void;
  onPrint: () => void;
  onDelete: () => void;
  onFocus: () => void;
  onFormattingMarks: () => void;
  onStatus: (value: string) => void;
}) {
  if (props.tab === "insert") return <div className="document-ribbon" role="toolbar" aria-label="Insert tools">
    <RibbonGroup label="Pages"><RibbonButton icon={FilePlus2} label="Blank page" onClick={() => props.onCommand("insertHTML", "<p><br></p>")} /></RibbonGroup>
    <RibbonGroup label="Tables"><RibbonButton icon={Table} label="Table" onClick={props.onInsertTable} /></RibbonGroup>
    <RibbonGroup label="Illustrations"><RibbonButton icon={ImageIcon} label="Picture" onClick={props.onInsertImage} /></RibbonGroup>
    <RibbonGroup label="Links"><RibbonButton icon={Link} label="Link" onClick={props.onInsertLink} /></RibbonGroup>
    <RibbonGroup label="Text"><RibbonButton icon={Minus} label="Rule" onClick={() => props.onCommand("insertHorizontalRule")} /><RibbonButton icon={FileText} label="Date & time" onClick={() => props.onCommand("insertText", new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date()))} /></RibbonGroup>
    <RibbonGroup label="Symbols"><div className="document-symbols" aria-label="Symbols">{["©", "®", "™", "€", "£", "—", "…"].map((symbol) => <button key={symbol} onClick={() => props.onCommand("insertText", symbol)}>{symbol}</button>)}</div></RibbonGroup>
  </div>;
  if (props.tab === "layout") return <div className="document-ribbon" role="toolbar" aria-label="Page layout tools">
    <RibbonGroup label="Page Setup"><RibbonSelect label="Margins" value={props.page.margins} onChange={(value) => props.onPage({ ...props.page, margins: value as DocumentPageSettings["margins"] })} options={[{ value: "normal", label: "Margins" }, { value: "narrow", label: "Narrow" }, { value: "wide", label: "Wide" }]} /><RibbonSelect label="Orientation" value={props.page.orientation} onChange={(value) => props.onPage({ ...props.page, orientation: value as DocumentPageSettings["orientation"] })} options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]} /><RibbonSelect label="Page size" value={props.page.size} onChange={(value) => props.onPage({ ...props.page, size: value as DocumentPageSettings["size"] })} options={[{ value: "letter", label: "Letter" }, { value: "a4", label: "A4" }]} /></RibbonGroup>
    <RibbonGroup label="Paragraph"><RibbonButton icon={IndentDecrease} label="Decrease" onClick={() => props.onCommand("outdent")} /><RibbonButton icon={IndentIncrease} label="Increase" onClick={() => props.onCommand("indent")} /></RibbonGroup>
  </div>;
  if (props.tab === "references") return <div className="document-ribbon" role="toolbar" aria-label="References tools">
    <RibbonGroup label="Table of Contents"><RibbonButton icon={ListChecks} label="Contents" onClick={() => props.onStatus("Automatic tables of contents are not available.")} /></RibbonGroup>
    <RibbonGroup label="Footnotes"><RibbonButton icon={BookOpen} label="Footnote" onClick={() => props.onStatus("Footnote editing is not available.")} /></RibbonGroup>
    <RibbonGroup label="Citations"><RibbonButton icon={FileText} label="Citation" onClick={() => props.onStatus("Citation management is not available yet.")} /></RibbonGroup>
  </div>;
  if (props.tab === "review") return <div className="document-ribbon" role="toolbar" aria-label="Review tools">
    <RibbonGroup label="Proofing"><RibbonButton icon={Sparkles} label="Editor" active={props.spellcheck} onClick={() => props.onSpellcheck(!props.spellcheck)} /><RibbonButton icon={SpellCheck2} label="Spelling" active={props.spellcheck} onClick={() => props.onSpellcheck(!props.spellcheck)} /></RibbonGroup>
    <RibbonGroup label="Language"><div className="document-ribbon-stat"><strong>{props.words.toLocaleString()}</strong><span>documents</span></div></RibbonGroup>
    <RibbonGroup label="Comments"><RibbonButton icon={MessageSquareText} label="New comment" onClick={() => props.onStatus("Comments and suggestions are not available.")} /></RibbonGroup>
    <RibbonGroup label="Changes"><RibbonButton icon={Activity} label="Track changes" onClick={() => props.onStatus("Track changes is not available yet.")} /></RibbonGroup>
  </div>;
  if (props.tab === "view") return <div className="document-ribbon" role="toolbar" aria-label="View tools">
    <RibbonGroup label="Views"><RibbonButton icon={Columns3} label="Pages" active onClick={() => props.onStatus("Separate pages view is active.")} /><RibbonButton icon={Pilcrow} label={props.focusMode ? "Exit focus" : "Focus"} active={props.focusMode} onClick={props.onFocus} /></RibbonGroup>
    <RibbonGroup label="Zoom"><RibbonSelect label="Zoom" value={String(props.zoom)} onChange={(value) => props.onZoom(Number(value))} options={[50, 75, 90, 100, 110, 125, 150, 180].map((value) => ({ value: String(value), label: `${value}%` }))} /><RibbonButton icon={Maximize2} label="100%" onClick={() => props.onZoom(100)} /></RibbonGroup>
    <RibbonGroup label="Window"><RibbonButton icon={Printer} label="Print" onClick={props.onPrint} /><RibbonButton icon={Download} label="Download" onClick={props.onDownload} /><RibbonButton icon={Trash2} label="Delete" danger onClick={props.onDelete} /></RibbonGroup>
  </div>;
  if (props.tab === "help") return <div className="document-ribbon" role="toolbar" aria-label="Help tools">
    <RibbonGroup label="Help"><RibbonButton icon={HelpCircle} label="Document help" onClick={() => props.onStatus("Search the command box for a tool, or use ⌘S, ⌘F, ⌘H, and ⌘O.")} /><RibbonButton icon={BookOpen} label="Shortcuts" onClick={() => props.onStatus("Shortcuts: save ⌘S, find ⌘F, replace ⌘H, open ⌘O, tool search ⌘Q.")} /></RibbonGroup>
  </div>;
  return <div className="document-ribbon" role="toolbar" aria-label="Home formatting tools">
    <RibbonGroup label="Undo"><div className="document-ribbon-cluster vertical"><RibbonIcon icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => props.onCommand("undo")} /><RibbonIcon icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => props.onCommand("redo")} /></div></RibbonGroup>
    <RibbonGroup label="Clipboard"><RibbonButton icon={ClipboardPaste} label="Paste" onClick={() => props.onStatus("Use ⌘V to paste into the document.")} /><div className="document-ribbon-cluster vertical"><RibbonIcon icon={Scissors} label="Cut" onClick={() => props.onCommand("cut")} /><RibbonIcon icon={Copy} label="Copy" onClick={() => props.onCommand("copy")} /><RibbonIcon icon={Paintbrush} label="Format painter" onClick={() => props.onStatus("Format painter is not available.")} /></div></RibbonGroup>
    <RibbonGroup label="Font" wide><div className="document-font-controls"><div><RibbonSelect label="Font" value="Arial" onChange={(value) => props.onCommand("fontName", value)} options={["Arial", "Aptos", "Calibri", "Georgia", "Times New Roman", "Verdana"].map((value) => ({ value, label: value }))} /><RibbonSelect label="Size" value="3" onChange={(value) => props.onCommand("fontSize", value)} compact options={[{ value: "1", label: "8" }, { value: "2", label: "10" }, { value: "3", label: "12" }, { value: "4", label: "14" }, { value: "5", label: "18" }, { value: "6", label: "24" }, { value: "7", label: "36" }]} /><RibbonIcon icon={AArrowUp} label="Grow font" onClick={() => props.onCommand("fontSize", "4")} /><RibbonIcon icon={AArrowDown} label="Shrink font" onClick={() => props.onCommand("fontSize", "2")} /><RibbonIcon icon={CaseUpper} label="Change case" onClick={props.onChangeCase} /></div><div className="document-ribbon-cluster font-row"><RibbonIcon icon={Bold} label="Bold" onClick={() => props.onCommand("bold")} /><RibbonIcon icon={Italic} label="Italic" onClick={() => props.onCommand("italic")} /><RibbonIcon icon={Underline} label="Underline" onClick={() => props.onCommand("underline")} /><RibbonIcon icon={Strikethrough} label="Strikethrough" onClick={() => props.onCommand("strikeThrough")} /><RibbonIcon icon={Subscript} label="Subscript" onClick={() => props.onCommand("subscript")} /><RibbonIcon icon={Superscript} label="Superscript" onClick={() => props.onCommand("superscript")} /><label className="document-color-tool" title="Text colour"><span>A</span><input type="color" defaultValue="#1a1a1a" onChange={(event) => props.onCommand("foreColor", event.target.value)} /></label><label className="document-color-tool highlight" title="Highlight colour"><Highlighter /><input type="color" defaultValue="#fff59d" onChange={(event) => props.onCommand("hiliteColor", event.target.value)} /></label><RibbonIcon icon={RemoveFormatting} label="Clear formatting" onClick={() => props.onCommand("removeFormat")} /></div></div></RibbonGroup>
    <RibbonGroup label="Paragraph"><div className="document-ribbon-cluster paragraph-grid"><RibbonIcon icon={List} label="Bullets" onClick={() => props.onCommand("insertUnorderedList")} /><RibbonIcon icon={ListOrdered} label="Numbering" onClick={() => props.onCommand("insertOrderedList")} /><RibbonIcon icon={ListTodo} label="Checklist" onClick={() => props.onCommand("insertText", "☐ ")} /><RibbonIcon icon={IndentDecrease} label="Decrease indent" onClick={() => props.onCommand("outdent")} /><RibbonIcon icon={IndentIncrease} label="Increase indent" onClick={() => props.onCommand("indent")} /><RibbonIcon icon={AlignLeft} label="Align left" onClick={() => props.onCommand("justifyLeft")} /><RibbonIcon icon={AlignCenter} label="Centre" onClick={() => props.onCommand("justifyCenter")} /><RibbonIcon icon={AlignRight} label="Align right" onClick={() => props.onCommand("justifyRight")} /><RibbonIcon icon={AlignJustify} label="Justify" onClick={() => props.onCommand("justifyFull")} /><RibbonIcon icon={Rows3} label="1.5 line spacing" onClick={() => props.onBlockStyle("line-height", "1.5")} /><RibbonIcon icon={Pilcrow} label="Show formatting marks" active={props.showFormattingMarks} onClick={props.onFormattingMarks} /><label className="document-color-tool paragraph-shading" title="Paragraph shading"><Highlighter /><input type="color" defaultValue="#fff59d" onChange={(event) => props.onBlockStyle("background-color", event.target.value)} /></label></div></RibbonGroup>
    <RibbonGroup label="Styles"><RibbonSelect label="Style" value="p" onChange={(value) => props.onCommand("formatBlock", value)} options={[{ value: "p", label: "Normal" }, { value: "h1", label: "Title" }, { value: "h2", label: "Heading 1" }, { value: "h3", label: "Heading 2" }, { value: "blockquote", label: "Quote" }]} /></RibbonGroup>
    <RibbonGroup label="Editing"><RibbonButton icon={Search} label="Find" onClick={props.onFind} /></RibbonGroup>
    <RibbonGroup label="Voice"><RibbonButton icon={Mic} label="Dictate" onClick={() => props.onStatus("Browser dictation is not available.")} /></RibbonGroup>
    <RibbonGroup label="Proofing"><RibbonButton icon={Sparkles} label="Editor" active={props.spellcheck} onClick={() => props.onSpellcheck(!props.spellcheck)} /></RibbonGroup>
    <RibbonGroup label="Add-ins"><RibbonButton icon={Puzzle} label="Add-ins" onClick={() => props.onStatus("Add-ins are not available yet.")} /></RibbonGroup>
  </div>;
}

function RibbonGroup(props: { label: string; wide?: boolean; children: ReactNode }) {
  return <section className={`document-ribbon-group ${props.wide ? "wide" : ""}`}><div className="document-ribbon-group-content">{props.children}</div><span className="document-ribbon-group-label">{props.label}</span></section>;
}

function RibbonButton(props: { icon: typeof FileText; label: string; active?: boolean; danger?: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return <button className={`document-ribbon-button ${props.active ? "active" : ""} ${props.danger ? "danger" : ""}`} onClick={props.onClick}><Icon /><span>{props.label}</span></button>;
}

function RibbonIcon(props: { icon: typeof FileText; label: string; active?: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return <button className={`document-icon-tool ${props.active ? "active" : ""}`} onClick={props.onClick} title={props.label} aria-label={props.label}><Icon /></button>;
}

function RibbonSelect(props: { label: string; value: string; compact?: boolean; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className={`document-ribbon-select ${props.compact ? "compact" : ""}`}><span className="sr-only">{props.label}</span><select value={props.value} onChange={(event) => props.onChange(event.target.value)}>{props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown /></label>;
}

function RibbonDivider() { return <span className="document-ribbon-divider" aria-hidden="true" />; }

function sanitizeDocumentHtml(value: string): string {
  const sanitized = DOMPurify.sanitize(value || EMPTY_DOCUMENT, {
    ALLOWED_TAGS: ["p", "div", "br", "span", "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "hr", "font"],
    ALLOWED_ATTR: ["style", "href", "target", "rel", "src", "alt", "title", "colspan", "rowspan", "color", "face", "size", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  });
  const parsed = new DOMParser().parseFromString(`<body>${sanitized}</body>`, "text/html");
  parsed.body.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = serializeDocumentStyle(element.getAttribute("style") || "");
    if (style) element.setAttribute("style", style);
    else element.removeAttribute("style");
  });
  return parsed.body.innerHTML || EMPTY_DOCUMENT;
}

function setDocumentHtml(editor: HTMLElement, value: string, page: DocumentPageSettings): number {
  editor.innerHTML = sanitizeDocumentHtml(value);
  // The production CSP intentionally blocks parsed inline style attributes.
  // Applying the validated declarations through CSSOM keeps the policy strict
  // while restoring document formatting for imported and previously saved files.
  hydrateDocumentStyles(editor);
  return paginateDocument(editor, page);
}

function serializeEditorHtml(editor: HTMLElement): string {
  const pages = Array.from(editor.querySelectorAll<HTMLElement>(":scope > .document-page"));
  return (pages.length ? pages.map((page) => page.innerHTML).join("") : editor.innerHTML) || EMPTY_DOCUMENT;
}

function paginateDocument(editor: HTMLElement, settings: DocumentPageSettings): number {
  const existingPages = Array.from(editor.querySelectorAll<HTMLElement>(":scope > .document-page"));
  const blocks = existingPages.length
    ? existingPages.flatMap((page) => Array.from(page.childNodes))
    : Array.from(editor.childNodes);
  editor.replaceChildren();

  function newPage(): HTMLElement {
    const page = document.createElement("section");
    page.className = `document-page size-${settings.size} orientation-${settings.orientation} margins-${settings.margins}`;
    page.setAttribute("aria-label", `Page ${editor.children.length + 1}`);
    editor.appendChild(page);
    return page;
  }

  let page = newPage();
  const content = blocks.length ? blocks : [document.createElement("p")];
  if (!blocks.length) content[0].appendChild(document.createElement("br"));
  content.forEach((block) => {
    page.appendChild(block);
    if (page.children.length > 1 && page.scrollHeight > page.clientHeight + 1) {
      page.removeChild(block);
      page = newPage();
      page.appendChild(block);
    }
  });
  return editor.children.length || 1;
}

function readDocumentNavigation(editor: HTMLElement): DocumentNavigation {
  const pages = Array.from(editor.querySelectorAll<HTMLElement>(":scope > .document-page"));
  const pagePreviews = pages.map((page) => page.innerText.replace(/\s+/g, " ").trim().slice(0, 72));
  const headings = Array.from(editor.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).map((heading, index) => ({
    index,
    label: heading.innerText.replace(/\s+/g, " ").trim() || `Heading ${index + 1}`,
    level: Number(heading.tagName.slice(1)) || 1,
    page: Math.max(1, pages.indexOf(heading.closest<HTMLElement>(".document-page") as HTMLElement) + 1),
  }));
  return { pages: pagePreviews.length ? pagePreviews : [""], headings };
}

function htmlToPlainText(value: string): string {
  return new DOMParser().parseFromString(value, "text/html").body.innerText || new DOMParser().parseFromString(value, "text/html").body.textContent || "";
}

function pasteCleanly(event: ClipboardEvent<HTMLDivElement>, onChanged: () => void) {
  event.preventDefault();
  const editor = event.currentTarget;
  const html = event.clipboardData.getData("text/html");
  const text = event.clipboardData.getData("text/plain");
  document.execCommand("insertHTML", false, html ? sanitizeDocumentHtml(html) : escapeHtml(text).replace(/\n/g, "<br>"));
  window.setTimeout(() => {
    hydrateDocumentStyles(editor);
    onChanged();
  }, 0);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordCount(value: string): number { return value.trim().match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length || 0; }
function relativeDocumentDate(value: string): string { const date = new Date(value); const diff = Date.now() - date.valueOf(); if (diff < 60_000) return "Just now"; if (diff < 86_400_000) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date); if (diff < 7 * 86_400_000) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.round(diff / 86_400_000), "day"); return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date); }
