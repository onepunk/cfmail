import { EMAIL_VIEWER_SANDBOX } from "../shared/emailViewer";
import {
  Archive,
  Activity,
  Ban,
  Bold,
  ArrowLeft,
  AtSign,
  Check,
  CalendarDays,
  ChevronDown,
  Download,
  Database,
  Filter,
  File,
  FileSpreadsheet,
  FileText,
  Grid3X3,
  Inbox,
  Italic,
  Tag,
  LogOut,
  Mail,
  MailOpen,
  Menu,
  MoreHorizontal,
  Paperclip,
  PenLine,
  RefreshCw,
  RotateCcw,
  Reply,
  ReplyAll,
  Search,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  UploadCloud,
  Users,
  Forward,
  X,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import type {
  AttachmentRecord,
  DomainRecord,
  DraftRecord,
  Folder,
  IdentityRecord,
  MailFilters,
  MailboxBootstrap,
  MessageDetail,
  MessageSummary,
  UploadRecord,
} from "../shared/types";
import { isDocumentAttachment } from "../shared/documentAttachments";
import { isSpreadsheetAttachment } from "../shared/spreadsheetAttachments";
import { ApiError, mailApi } from "./api";
import { presentMessages, type InboxSort, type InboxView } from "./inboxPresentation";
import { mergeRefreshedMessages, newMessageCount } from "./mailRefresh";

type View = "mail" | "drafts" | "domains" | "documents" | "spreadsheets" | "calendar";
type MessageAction = "read" | "unread" | "star" | "unstar" | "archive" | "spam" | "not_spam" | "trash" | "restore";
const MESSAGE_PAGE_SIZE = 50;
const DocumentApp = lazy(() => import("./DocumentApp").then((module) => ({ default: module.DocumentApp })));
const SpreadsheetApp = lazy(() => import("./SpreadsheetApp").then((module) => ({ default: module.SpreadsheetApp })));
const CalendarApp = lazy(() => import("./CalendarApp").then((module) => ({ default: module.CalendarApp })));

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginUrl, setLoginUrl] = useState("/cdn-cgi/access/login");

  useEffect(() => {
    mailApi
      .session()
      .then((session) => setAuthenticated(session.authenticated))
      .catch((error) => {
        if (error instanceof ApiError && error.loginUrl) setLoginUrl(error.loginUrl);
        setAuthenticated(false);
      });
  }, []);

  if (authenticated === null) return <LoadingScreen />;
  if (!authenticated) return <Login loginUrl={loginUrl} />;
  return <Mailbox onLoggedOut={() => setAuthenticated(false)} />;
}

function LoadingScreen() {
  return (
    <main className="splash" aria-label="Loading cfmail">
      <BrandMark />
      <span className="loader" aria-hidden="true" />
      <span className="sr-only">Loading mailbox</span>
    </main>
  );
}

function Login({ loginUrl }: { loginUrl: string }) {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-heading">
        <BrandMark />
        <div className="login-copy">
          <p className="eyebrow">Private mail workspace</p>
          <h1 id="login-heading">Welcome to cfmail</h1>
          <p>One calm inbox for every domain you manage. Access is restricted to the mailbox owner.</p>
        </div>
        <div className="access-identity"><Avatar value="Mailbox owner" /><span><strong>Mailbox owner</strong><small>Only the configured account is permitted</small></span></div>
        <a className="button primary wide" href={loginUrl}>Continue securely</a>
        <p className="login-security"><ShieldCheck size={16} /> Cloudflare Access verifies a one-time code and protects every mailbox request.</p>
      </section>
    </main>
  );
}

function Mailbox({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [bootstrap, setBootstrap] = useState<MailboxBootstrap | null>(null);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [domainId, setDomainId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ message: MessageDetail; thread: MessageDetail[] } | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [checkingMail, setCheckingMail] = useState(false);
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<MailFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [view, setView] = useState<View>("mail");
  const [documentAttachment, setDocumentAttachment] = useState<AttachmentRecord | null>(null);
  const [spreadsheetAttachment, setSpreadsheetAttachment] = useState<AttachmentRecord | null>(null);
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [status, setStatus] = useState("");
  const [pendingSend, setPendingSend] = useState<{ id: string; sendAfter: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const messageRequestId = useRef(0);
  const messagesRef = useRef<MessageSummary[]>([]);
  const mailboxReadyRef = useRef(false);

  const loadBootstrap = useCallback(async () => {
    try {
      setBootstrap(await mailApi.bootstrap());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLoggedOut();
      else setStatus("Could not refresh mailbox configuration.");
    }
  }, [onLoggedOut]);

  const loadMessages = useCallback(async (
    { cursor = null, append = false, silent = false }: { cursor?: string | null; append?: boolean; silent?: boolean } = {},
  ) => {
    const requestId = messageRequestId.current + 1;
    messageRequestId.current = requestId;
    if (silent) setCheckingMail(true);
    else if (append) setLoadingMoreMessages(true);
    else {
      mailboxReadyRef.current = false;
      setLoadingMessages(true);
      setMessages([]);
      setNextMessageCursor(null);
    }
    try {
      const result = await mailApi.messages(folder, domainId, query, cursor, MESSAGE_PAGE_SIZE, filters);
      if (requestId !== messageRequestId.current) return;
      if (!append) mailboxReadyRef.current = true;
      const arrived = silent ? newMessageCount(messagesRef.current, result.messages) : 0;
      setMessages((current) => {
        let next: MessageSummary[];
        if (append) {
          const existing = new Set(current.map((message) => message.id));
          next = [...current, ...result.messages.filter((message) => !existing.has(message.id))];
        } else if (silent) next = mergeRefreshedMessages(current, result.messages, MESSAGE_PAGE_SIZE);
        else next = result.messages;
        messagesRef.current = next;
        return next;
      });
      if (!silent || messagesRef.current.length <= MESSAGE_PAGE_SIZE) setNextMessageCursor(result.nextCursor);
      if (arrived) {
        setStatus(`${arrived} new message${arrived === 1 ? "" : "s"} arrived.`);
        void loadBootstrap();
      }
    } catch (error) {
      if (requestId !== messageRequestId.current) return;
      if (error instanceof ApiError && error.status === 401) onLoggedOut();
      else if (!silent) setStatus("Messages could not be loaded.");
    } finally {
      if (requestId === messageRequestId.current) {
        if (!silent) setLoadingMessages(false);
        setLoadingMoreMessages(false);
        setCheckingMail(false);
      }
    }
  }, [domainId, filters, folder, loadBootstrap, onLoggedOut, query]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => void loadBootstrap(), [loadBootstrap]);
  useEffect(() => {
    if (view === "mail") void loadMessages();
  }, [loadMessages, view]);

  useEffect(() => {
    if (view !== "mail") return;
    const checkForMail = () => {
      if (mailboxReadyRef.current && document.visibilityState === "visible" && navigator.onLine) void loadMessages({ silent: true });
    };
    const visibilityChanged = () => { if (document.visibilityState === "visible") checkForMail(); };
    const interval = window.setInterval(checkForMail, 15_000);
    window.addEventListener("focus", checkForMail);
    window.addEventListener("online", checkForMail);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkForMail);
      window.removeEventListener("online", checkForMail);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [loadMessages, view]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        setCompose({ mode: "compose" });
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (detail && key === "r") {
        event.preventDefault();
        setCompose({ mode: event.shiftKey ? "replyAll" : "reply", message: detail.message });
      } else if (detail && key === "f") {
        event.preventDefault();
        setCompose({ mode: "forward", message: detail.message });
      } else if (event.key === "Escape" && selectedId) {
        setSelectedId(null);
        setDetail(null);
      }
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [detail, selectedId]);

  async function selectMessage(id: string) {
    setSelectedId(id);
    setLoadingDetail(true);
    history.pushState({ messageId: id }, "", `#message/${id}`);
    try {
      setDetail(await mailApi.message(id));
      setMessages((current) => current.map((message) => (message.id === id ? { ...message, isRead: true } : message)));
      void loadBootstrap();
    } catch {
      setStatus("That message could not be opened.");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function messageAction(id: string, action: MessageAction) {
    const previous = messages;
    const previousSelectedIds = selectedIds;
    const previousSelectedId = selectedId;
    const previousDetail = detail;
    if (["archive", "trash", "restore"].includes(action)) {
      setMessages((current) => current.filter((message) => message.id !== id));
      setSelectedIds((current) => current.filter((selected) => selected !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
    } else {
      setMessages((current) =>
        current.map((message) =>
          message.id === id
            ? { ...message, isRead: action === "read" ? true : action === "unread" ? false : message.isRead, isStarred: action === "star" ? true : action === "unstar" ? false : message.isStarred }
            : message,
        ),
      );
    }
    try {
      await mailApi.updateMessage(id, action);
      setStatus(action === "trash" ? "Message moved to Trash. Undo is available from Trash." : "Mailbox updated.");
      void loadBootstrap();
    } catch {
      setMessages(previous);
      setSelectedIds(previousSelectedIds);
      setSelectedId(previousSelectedId);
      setDetail(previousDetail);
      setStatus("The mailbox change could not be saved.");
    }
  }

  async function logout() {
    const result = await mailApi.logout().catch(() => ({ logoutUrl: "/cdn-cgi/access/logout" }));
    window.location.assign(result.logoutUrl);
  }

  async function bulkAction(action: MessageAction, ids = selectedIds) {
    if (!ids.length) return;
    try {
      await mailApi.bulkMessages(ids, action);
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      setStatus(`${ids.length} message${ids.length === 1 ? "" : "s"} updated.`);
      await Promise.all([loadMessages(), loadBootstrap()]);
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "The bulk action could not be saved.");
    }
  }

  const selectedDomain = bootstrap?.domains.find((domain) => domain.id === domainId) || null;
  const currentIdentity = bootstrap?.identities.find((identity) => identity.id === detail?.message.identityId);

  if (view === "documents") {
    return <Suspense fallback={<LoadingScreen />}><DocumentApp
      userEmail={bootstrap?.user.email || ""}
      initialAttachment={documentAttachment}
      onInitialAttachmentHandled={() => setDocumentAttachment(null)}
      onExit={() => { setDocumentAttachment(null); setView("mail"); }}
      onLogout={() => void logout()}
    /></Suspense>;
  }

  if (view === "spreadsheets") {
    return <Suspense fallback={<LoadingScreen />}><SpreadsheetApp
      userEmail={bootstrap?.user.email || ""}
      initialAttachment={spreadsheetAttachment}
      onInitialAttachmentHandled={() => setSpreadsheetAttachment(null)}
      onExit={() => { setSpreadsheetAttachment(null); setView("mail"); }}
      onLogout={() => void logout()}
    /></Suspense>;
  }

  if (view === "calendar") {
    return <Suspense fallback={<LoadingScreen />}><CalendarApp
      userEmail={bootstrap?.user.email || ""}
      onExit={() => setView("mail")}
      onLogout={() => void logout()}
    /></Suspense>;
  }

  return (
    <div className={`app-shell ${selectedId ? "reader-open" : ""}`}>
      <header className="topbar">
        <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu /></button>
        <AppLauncher
          onCalendar={() => setView("calendar")}
          onDocuments={() => { setDocumentAttachment(null); setView("documents"); }}
          onSpreadsheets={() => { setSpreadsheetAttachment(null); setView("spreadsheets"); }}
        />
        <BrandMark compact />
        <form
          className="search-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setSelectedId(null);
            setDetail(null);
            setQuery(searchDraft.trim());
          }}
        >
          <Search size={18} aria-hidden="true" />
          <label className="sr-only" htmlFor="mail-search">Search mail</label>
          <input
            ref={searchRef}
            id="mail-search"
            type="search"
            placeholder="Search sender, subject, or message…"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <kbd>/</kbd>
        </form>
        <button className={`button quiet filter-toggle ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((value) => !value)}><Filter size={17} /> Filters</button>
        <button className="topbar-account" onClick={() => void logout()} title="Sign out" aria-label={`Signed in as ${bootstrap?.user.email || "mailbox owner"}. Sign out`}><span className="topbar-account-label">{bootstrap?.user.email}</span><Avatar value={bootstrap?.user.email || "V"} /><LogOut size={15} /></button>
      </header>

      {showFilters ? (
        <SearchFilters
          filters={filters}
          labels={bootstrap?.labels || []}
          onApply={(next) => { setFilters(next); setSelectedId(null); setShowFilters(false); }}
          onClear={() => { setFilters({}); setShowFilters(false); }}
        />
      ) : null}

      <div className="mailbox-layout" id="main-content">
        <Sidebar
          bootstrap={bootstrap}
          folder={folder}
          domainId={domainId}
          view={view}
          open={mobileNav}
          onClose={() => setMobileNav(false)}
          onCompose={() => setCompose({ mode: "compose" })}
          onFolder={(nextFolder, nextDomain) => {
            setFolder(nextFolder);
            setDomainId(nextDomain);
            setSelectedIds([]);
            setView("mail");
            setSelectedId(null);
            setMobileNav(false);
          }}
          onSettings={() => {
            setView("domains");
            setMobileNav(false);
          }}
          onDrafts={(nextDomain) => {
            setDomainId(nextDomain);
            setView("drafts");
            setSelectedId(null);
            setMobileNav(false);
          }}
        />

        {view === "domains" ? (
          <DomainSettings bootstrap={bootstrap} onChanged={loadBootstrap} />
        ) : view === "drafts" && bootstrap ? (
          <DraftsPane
            identities={bootstrap.identities}
            domain={selectedDomain}
            onCompose={async (draft) => {
              if (!draft.replyToMessageId) {
                setCompose({ mode: "compose", draft });
                return;
              }
              try {
                const target = await mailApi.message(draft.replyToMessageId);
                setCompose({ mode: "reply", draft, message: target.message });
              } catch {
                setStatus("The original message could not be loaded; the draft remains saved.");
              }
            }}
          />
        ) : (
          <>
            <MessageList
              messages={messages}
              loading={loadingMessages}
              loadingMore={loadingMoreMessages}
              checking={checkingMail}
              hasMore={Boolean(nextMessageCursor)}
              folder={folder}
              domain={selectedDomain}
              selectedId={selectedId}
              query={query}
              selectedIds={selectedIds}
              onToggleSelected={(id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
              onToggleAll={(ids) => setSelectedIds((current) => {
                const visible = new Set(ids);
                return ids.length && ids.every((id) => current.includes(id))
                  ? current.filter((id) => !visible.has(id))
                  : Array.from(new Set([...current, ...ids]));
              })}
              onBulk={(action, ids) => void bulkAction(action, ids)}
              onSelect={(id) => void selectMessage(id)}
              onStar={(message) => void messageAction(message.id, message.isStarred ? "unstar" : "star")}
              onAction={(message, action) => void messageAction(message.id, action)}
              onRefresh={() => void loadMessages({ silent: true })}
              onLoadMore={() => nextMessageCursor && void loadMessages({ cursor: nextMessageCursor, append: true })}
              onBack={() => setMobileNav(true)}
            />
            <Reader
              detail={detail}
              loading={loadingDetail}
              identity={currentIdentity}
              folder={folder}
              onBack={() => {
                setSelectedId(null);
                setDetail(null);
                history.pushState({}, "", "#");
              }}
              onReply={(message) => setCompose({ mode: "reply", message })}
              onReplyAll={(message) => setCompose({ mode: "replyAll", message })}
              onForward={(message) => setCompose({ mode: "forward", message })}
              onOpenDocument={(attachment) => { setDocumentAttachment(attachment); setView("documents"); }}
              onOpenSpreadsheet={(attachment) => { setSpreadsheetAttachment(attachment); setView("spreadsheets"); }}
              onArchive={() => detail && void messageAction(detail.message.id, "archive")}
              onTrash={() => detail && void messageAction(detail.message.id, "trash")}
              onRestore={() => detail && void messageAction(detail.message.id, "restore")}
              onUnread={() => detail && void messageAction(detail.message.id, "unread")}
              onSpam={() => detail && void messageAction(detail.message.id, folder === "spam" ? "not_spam" : "spam")}
              onDelete={async () => {
                if (!detail || !window.confirm("Permanently delete this message and its stored files? This cannot be undone.")) return;
                await mailApi.deleteMessage(detail.message.id);
                setSelectedId(null); setDetail(null); setStatus("Message permanently deleted."); void loadMessages(); void loadBootstrap();
              }}
              labels={bootstrap?.labels || []}
              onLabels={async (labelIds) => {
                if (!detail) return;
                await mailApi.setLabels(detail.message.id, labelIds);
                setDetail(await mailApi.message(detail.message.id));
                void loadMessages();
              }}
            />
          </>
        )}
      </div>

      <div className="live-status" aria-live="polite" aria-atomic="true">{status}</div>
      {pendingSend ? <div className="undo-toast"><span>Message scheduled for delivery.</span><button className="button quiet" onClick={async () => { try { await mailApi.updateMessage(pendingSend.id, "cancel"); setPendingSend(null); setStatus("Send cancelled."); void loadMessages(); } catch { setStatus("It is too late to cancel this send."); setPendingSend(null); } }}><RotateCcw size={16} /> Undo send</button></div> : null}
      {compose && bootstrap ? (
        <Composer
          seed={compose}
          domains={bootstrap.domains}
          identities={bootstrap.identities}
          onClose={() => setCompose(null)}
          onSent={(scheduled) => {
            setCompose(null);
            setFolder("sent");
            setView("mail");
            setStatus(`Message scheduled. Undo is available for ${Math.max(0, Math.ceil((Date.parse(scheduled.sendAfter) - Date.now()) / 1000))} seconds.`);
            setPendingSend(scheduled);
            window.setTimeout(() => setPendingSend((current) => current?.id === scheduled.id ? null : current), Math.max(0, Date.parse(scheduled.sendAfter) - Date.now()) + 500);
            window.setTimeout(() => setStatus(""), 12_000);
            void loadMessages();
          }}
        />
      ) : null}
    </div>
  );
}

function AppLauncher(props: { onCalendar: () => void; onDocuments: () => void; onSpreadsheets: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", keydown); };
  }, [open]);
  return <div className="app-launcher" ref={rootRef}>
    <button className="app-launcher-button" onClick={() => setOpen((value) => !value)} aria-label="App launcher" aria-expanded={open} aria-haspopup="menu" title="Apps"><Grid3X3 /></button>
    {open ? <div className="app-launcher-flyout" role="menu">
      <header><strong>Apps</strong><small>cfmail</small></header>
      <button role="menuitem" onClick={() => { setOpen(false); props.onCalendar(); }}><span className="app-icon calendar">C</span><span><strong>Calendar</strong><small>Schedule and events</small></span><CalendarDays /></button>
      <button role="menuitem" onClick={() => { setOpen(false); props.onDocuments(); }}><span className="app-icon documents">D</span><span><strong>Documents</strong><small>Write and edit</small></span><FileText /></button>
      <button role="menuitem" onClick={() => { setOpen(false); props.onSpreadsheets(); }}><span className="app-icon spreadsheets">S</span><span><strong>Spreadsheets</strong><small>Tables and formulas</small></span><FileSpreadsheet /></button>
    </div> : null}
  </div>;
}

function SearchFilters(props: {
  filters: MailFilters;
  labels: MailboxBootstrap["labels"];
  onApply: (filters: MailFilters) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(props.filters);
  return <aside className="filter-panel" aria-label="Advanced search filters">
    <div><label>From<input value={draft.sender || ""} onChange={(event) => setDraft({ ...draft, sender: event.target.value })} placeholder="sender@example.com" /></label><label>To or Cc<input value={draft.recipient || ""} onChange={(event) => setDraft({ ...draft, recipient: event.target.value })} placeholder="recipient@example.com" /></label><label>From date<input type="date" value={draft.dateFrom || ""} onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })} /></label><label>To date<input type="date" value={draft.dateTo || ""} onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })} /></label><label>Label<select value={draft.labelId || ""} onChange={(event) => setDraft({ ...draft, labelId: event.target.value || undefined })}><option value="">Any label</option>{props.labels.map((label) => <option value={label.id} key={label.id}>{label.name}</option>)}</select></label></div>
    <div className="filter-checks"><label><input type="checkbox" checked={Boolean(draft.attachment)} onChange={(event) => setDraft({ ...draft, attachment: event.target.checked })} /> Has attachment</label><label><input type="checkbox" checked={Boolean(draft.unread)} onChange={(event) => setDraft({ ...draft, unread: event.target.checked })} /> Unread</label><label><input type="checkbox" checked={Boolean(draft.starred)} onChange={(event) => setDraft({ ...draft, starred: event.target.checked })} /> Starred</label><button className="button quiet" onClick={props.onClear}>Clear</button><button className="button primary" onClick={() => props.onApply(draft)}>Apply filters</button></div>
  </aside>;
}

function Sidebar(props: {
  bootstrap: MailboxBootstrap | null;
  folder: Folder;
  domainId: string | null;
  view: View;
  open: boolean;
  onClose: () => void;
  onCompose: () => void;
  onFolder: (folder: Folder, domainId: string | null) => void;
  onSettings: () => void;
  onDrafts: (domainId: string | null) => void;
}) {
  const folders: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
    { id: "inbox", label: "Inbox", icon: Inbox },
    { id: "sent", label: "Sent", icon: Send },
    { id: "archive", label: "Archive", icon: Archive },
    { id: "spam", label: "Spam", icon: Ban },
    { id: "trash", label: "Trash", icon: Trash2 },
  ];
  const [expandedDomains, setExpandedDomains] = useState<string[]>([]);

  useEffect(() => {
    if (!props.domainId) return;
    setExpandedDomains((current) => current.includes(props.domainId as string) ? current : [...current, props.domainId as string]);
  }, [props.domainId]);

  function toggleDomain(domainId: string) {
    setExpandedDomains((current) => current.includes(domainId) ? current.filter((id) => id !== domainId) : [...current, domainId]);
  }

  return (
    <>
      {props.open ? <button className="nav-scrim" aria-label="Close navigation" onClick={props.onClose} /> : null}
      <aside className={`sidebar ${props.open ? "open" : ""}`} aria-label="Mailbox navigation">
        <button className="button primary compose-button" onClick={props.onCompose}><PenLine size={18} /> New mail <kbd>c</kbd></button>
        <nav aria-label="Folders">
          <p className="nav-heading">Mail</p>
          {folders.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${props.view === "mail" && props.domainId === null && props.folder === id ? "active" : ""}`} onClick={() => props.onFolder(id, null)}>
              <Icon size={18} /> <span>{label}</span>
              {folderCount(props.bootstrap, null, id) ? <span className="count-badge">{folderCount(props.bootstrap, null, id)}</span> : null}
            </button>
          ))}
          <button className={`nav-item ${props.view === "drafts" && props.domainId === null ? "active" : ""}`} onClick={() => props.onDrafts(null)}>
            <FileText size={18} /> <span>Drafts</span>
          </button>
        </nav>
        {props.bootstrap?.labels.length ? (
          <nav aria-label="Labels" className="label-nav">
            <p className="nav-heading">Labels</p>
            {props.bootstrap.labels.map((label) => <div className="label-nav-row" key={label.id}><span style={{ background: label.color }} />{label.name}</div>)}
          </nav>
        ) : null}
        <nav aria-label="Domains" className="domain-nav">
          <p className="nav-heading">Domains</p>
          {props.bootstrap?.domains.map((domain) => {
            const expanded = expandedDomains.includes(domain.id);
            const selected = props.domainId === domain.id && (props.view === "mail" || props.view === "drafts");
            return (
              <section className="domain-account" key={domain.id}>
                <button
                  className={`nav-item domain-account-toggle ${selected ? "selected" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={`domain-folders-${domain.id}`}
                  onClick={() => toggleDomain(domain.id)}
                >
                  <span className="domain-dot">{domain.label.slice(0, 1).toUpperCase()}</span>
                  <span className="truncate">{domain.label}</span>
                  <ChevronDown size={14} className="domain-chevron" aria-hidden="true" />
                </button>
                {expanded ? (
                  <div className="domain-folder-list" id={`domain-folders-${domain.id}`} role="group" aria-label={`${domain.label} folders`}>
                    {folders.map(({ id, label, icon: Icon }) => (
                      <button key={id} className={`nav-item ${props.view === "mail" && props.domainId === domain.id && props.folder === id ? "active" : ""}`} onClick={() => props.onFolder(id, domain.id)}>
                        <Icon size={16} /> <span>{label}</span>
                        {folderCount(props.bootstrap, domain.id, id) ? <span className="count-badge">{folderCount(props.bootstrap, domain.id, id)}</span> : null}
                      </button>
                    ))}
                    <button className={`nav-item ${props.view === "drafts" && props.domainId === domain.id ? "active" : ""}`} onClick={() => props.onDrafts(domain.id)}>
                      <FileText size={16} /> <span>Drafts</span>
                    </button>
                  </div>
                ) : null}
              </section>
            );
          })}
        </nav>
        <button className={`nav-item settings-link ${props.view === "domains" ? "active" : ""}`} onClick={props.onSettings}><Settings size={18} /> Domains & identities</button>
      </aside>
    </>
  );
}

function MessageList(props: {
  messages: MessageSummary[];
  loading: boolean;
  loadingMore: boolean;
  checking: boolean;
  hasMore: boolean;
  folder: Folder;
  domain: DomainRecord | null;
  selectedId: string | null;
  selectedIds: string[];
  query: string;
  onSelect: (id: string) => void;
  onStar: (message: MessageSummary) => void;
  onAction: (message: MessageSummary, action: MessageAction) => void;
  onToggleSelected: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onBulk: (action: MessageAction, ids: string[]) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onBack: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [inboxView, setInboxView] = useState<InboxView>("all");
  const [inboxSort, setInboxSort] = useState<InboxSort>("newest");
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const groups = useMemo(() => presentMessages(props.messages, inboxView, inboxSort), [inboxSort, inboxView, props.messages]);
  const visibleMessages = useMemo(() => groups.flatMap((group) => group.messages), [groups]);
  const visibleIds = useMemo(() => visibleMessages.map((message) => message.id), [visibleMessages]);
  const visibleSelectedIds = useMemo(() => props.selectedIds.filter((id) => visibleIds.includes(id)), [props.selectedIds, visibleIds]);
  const viewCounts = useMemo(() => ({
    all: props.messages.length,
    unread: props.messages.filter((message) => !message.isRead).length,
    starred: props.messages.filter((message) => message.isStarred).length,
    attachments: props.messages.filter((message) => message.hasAttachments).length,
  }), [props.messages]);

  useEffect(() => {
    setActiveIndex(0);
    setInboxView("all");
  }, [props.folder, props.domain?.id, props.query]);

  useEffect(() => {
    if (activeIndex >= visibleMessages.length) setActiveIndex(Math.max(visibleMessages.length - 1, 0));
  }, [activeIndex, visibleMessages.length]);

  function navigate(event: ReactKeyboardEvent, index: number) {
    if (!["ArrowDown", "ArrowUp", "j", "k", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") return props.onSelect(visibleMessages[index].id);
    const direction = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
    const next = Math.min(Math.max(index + direction, 0), visibleMessages.length - 1);
    setActiveIndex(next);
    rowRefs.current[next]?.focus();
  }

  const tabs: Array<{ id: InboxView; label: string }> = [
    { id: "all", label: "All" },
    { id: "unread", label: "Unread" },
    { id: "starred", label: "Starred" },
    { id: "attachments", label: "Files" },
  ];
  const emptyViewLabel = tabs.find((tab) => tab.id === inboxView)?.label.toLowerCase() || "matching";

  return (
    <section className="message-pane" aria-labelledby="message-list-heading">
      <header className="pane-header">
        <button className="icon-button mobile-back" onClick={props.onBack} aria-label="Open navigation"><Menu /></button>
        <div>
          <p className="eyebrow">{props.domain?.name || "All domains"}</p>
          <h1 id="message-list-heading">{folderLabel(props.folder)}</h1>
        </div>
        <span className={`mail-live-indicator ${props.checking ? "checking" : ""}`} title="cfmail checks for new messages automatically"><i />{props.checking ? "Checking…" : "Live"}</span>
        <button className="icon-button" onClick={props.onRefresh} aria-label="Refresh messages"><RefreshCw /></button>
      </header>
      {props.query ? <div className="filter-chip">Search: <strong>{props.query}</strong></div> : null}
      <div className="message-view-toolbar">
        <div className="message-view-tabs" role="tablist" aria-label="Message views">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={inboxView === tab.id}
              className={inboxView === tab.id ? "active" : ""}
              onClick={() => { setInboxView(tab.id); setActiveIndex(0); }}
            >
              {tab.label}<span>{viewCounts[tab.id]}</span>
            </button>
          ))}
        </div>
        <label className="message-sort">
          <span className="sr-only">Sort messages</span>
          <select value={inboxSort} onChange={(event) => { setInboxSort(event.target.value as InboxSort); setActiveIndex(0); }} aria-label="Sort messages">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="sender">Sender</option>
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
      </div>
      <div className="bulk-toolbar">
        <label><input type="checkbox" checked={Boolean(visibleIds.length) && visibleSelectedIds.length === visibleIds.length} onChange={() => props.onToggleAll(visibleIds)} /> <span>{visibleSelectedIds.length ? `${visibleSelectedIds.length} selected` : "Select all"}</span></label>
        {visibleSelectedIds.length ? <div><button onClick={() => props.onBulk("read", visibleSelectedIds)}>Read</button><button onClick={() => props.onBulk("archive", visibleSelectedIds)}>Archive</button><button onClick={() => props.onBulk(props.folder === "spam" ? "not_spam" : "spam", visibleSelectedIds)}>{props.folder === "spam" ? "Not spam" : "Spam"}</button><button onClick={() => props.onBulk(props.folder === "trash" ? "restore" : "trash", visibleSelectedIds)}>{props.folder === "trash" ? "Restore" : "Trash"}</button></div> : null}
      </div>
      <div className="message-list" role="listbox" aria-label={`${folderLabel(props.folder)} messages`}>
        {props.loading ? <MessageSkeleton /> : null}
        {!props.loading && !visibleMessages.length ? (
          <EmptyState
            icon={props.folder === "inbox" ? Inbox : Mail}
            title={props.messages.length ? `No ${emptyViewLabel} messages` : `No ${folderLabel(props.folder).toLowerCase()} messages`}
            copy={props.query ? "Try a broader search or another quick view." : props.messages.length ? "Choose another view to see the rest of your mail." : "This view is clear."}
          />
        ) : null}
        {groups.map((group) => (
          <section className="message-group" key={group.key} aria-labelledby={`message-group-${group.key}`}>
            <h2 id={`message-group-${group.key}`}>{group.label}<span>{group.messages.length}</span></h2>
            {group.messages.map((message) => {
              const index = visibleMessages.findIndex((item) => item.id === message.id);
              return (
                <article key={message.id} className={`message-row ${message.isRead ? "" : "unread"} ${message.id === props.selectedId ? "selected" : ""}`}>
                  <input className="message-select" type="checkbox" checked={props.selectedIds.includes(message.id)} onChange={() => props.onToggleSelected(message.id)} aria-label={`Select ${message.subject}`} />
                  <MessageAvatar message={message} />
                  <button
                    ref={(element) => { rowRefs.current[index] = element; }}
                    className="message-row-main selectable with-avatar"
                    role="option"
                    aria-selected={message.id === props.selectedId}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => navigate(event, index)}
                    onClick={() => props.onSelect(message.id)}
                  >
                    <span className="sender-line"><span className="sender truncate">{message.fromName || message.fromEmail}</span><time>{relativeDate(message.receivedAt)}</time></span>
                    <span className="subject-line"><span className="subject truncate">{message.subject}</span>{message.messageCount > 1 ? <span className="thread-count">{message.messageCount}</span> : null}</span>
                    <span className="preview truncate">{message.preview || "No message preview"}</span>
                    <span className="message-flags">{message.hasAttachments ? <Paperclip size={14} aria-label="Has attachments" /> : null}{message.deliveryStatus === "failed" ? <span className="failed-label">Send failed</span> : null}</span>
                  </button>
                  <div className="message-row-actions" role="group" aria-label={`Actions for ${message.subject}`}>
                    <button className={`star-button ${message.isStarred ? "active" : ""}`} onClick={() => props.onStar(message)} aria-label={message.isStarred ? "Remove star" : "Star message"} title={message.isStarred ? "Remove star" : "Star"}><Star size={16} fill={message.isStarred ? "currentColor" : "none"} /></button>
                    <button className="row-hover-action" onClick={() => props.onAction(message, message.isRead ? "unread" : "read")} aria-label={message.isRead ? "Mark as unread" : "Mark as read"} title={message.isRead ? "Mark as unread" : "Mark as read"}>{message.isRead ? <Mail size={15} /> : <MailOpen size={15} />}</button>
                    {props.folder !== "archive" && props.folder !== "trash" ? <button className="row-hover-action" onClick={() => props.onAction(message, "archive")} aria-label="Archive message" title="Archive"><Archive size={15} /></button> : null}
                    <button className="row-hover-action danger" onClick={() => props.onAction(message, props.folder === "trash" ? "restore" : "trash")} aria-label={props.folder === "trash" ? "Restore message" : "Move message to trash"} title={props.folder === "trash" ? "Restore" : "Trash"}>{props.folder === "trash" ? <Check size={15} /> : <Trash2 size={15} />}</button>
                  </div>
                </article>
              );
            })}
          </section>
        ))}
        {props.hasMore ? (
          <div className="load-more-row">
            <button className="button quiet" onClick={props.onLoadMore} disabled={props.loadingMore}>
              {props.loadingMore ? "Loading more…" : "Load older messages"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MessageAvatar({ message }: { message: MessageSummary }) {
  const sender = (message.fromName || message.fromEmail).trim();
  const parts = sender.split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] || ""}` : sender.slice(0, 1)).toLocaleUpperCase();
  const hue = Array.from(message.fromEmail).reduce((total, character) => total + character.charCodeAt(0), 0) % 6;
  return <span className={`message-avatar hue-${hue}`} aria-hidden="true">{initials}</span>;
}

function Reader(props: {
  detail: { message: MessageDetail; thread: MessageDetail[] } | null;
  loading: boolean;
  identity?: IdentityRecord;
  folder: Folder;
  onBack: () => void;
  onReply: (message: MessageDetail) => void;
  onReplyAll: (message: MessageDetail) => void;
  onForward: (message: MessageDetail) => void;
  onOpenDocument: (attachment: AttachmentRecord) => void;
  onOpenSpreadsheet: (attachment: AttachmentRecord) => void;
  onArchive: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onUnread: () => void;
  onSpam: () => void;
  onDelete: () => void;
  labels: MailboxBootstrap["labels"];
  onLabels: (labelIds: string[]) => void;
}) {
  const [showHtml, setShowHtml] = useState<Record<string, boolean>>({});
  if (props.loading) return <main className="reader-pane"><MessageReaderSkeleton /></main>;
  if (!props.detail) {
    return (
      <main className="reader-pane reader-empty" aria-label="Message reader">
        <div className="reader-empty-art"><Mail /></div>
        <h2>Select a message</h2>
        <p>Choose a conversation from the list, or press <kbd>j</kbd>/<kbd>k</kbd> to move and Enter to open.</p>
      </main>
    );
  }
  const { message, thread } = props.detail;
  return (
    <main className="reader-pane" aria-labelledby="message-subject">
      <header className="reader-toolbar">
        <button className="button quiet reader-back" onClick={props.onBack}><ArrowLeft size={17} /> Back</button>
        <div className="toolbar-actions">
          {props.folder === "trash" ? <><button className="button quiet" onClick={props.onRestore}><Check size={17} /> Restore</button><button className="button quiet danger" onClick={props.onDelete}><Trash2 size={17} /> Delete forever</button></> : (
            <>
              <button className="button quiet" onClick={props.onUnread}><Mail size={17} /> Unread</button>
              <button className="button quiet" onClick={props.onArchive}><Archive size={17} /> Archive</button>
              <button className="button quiet" onClick={props.onSpam}><Ban size={17} /> {props.folder === "spam" ? "Not spam" : "Spam"}</button>
              <button className="button quiet danger" onClick={props.onTrash}><Trash2 size={17} /> Trash</button>
            </>
          )}
        </div>
        <div className="reader-respond-toolbar" aria-label="Respond to message">
          <button className="icon-button" onClick={() => props.onReply(message)} title="Reply (R)" aria-label="Reply"><Reply size={18} /></button>
          <button className="icon-button" onClick={() => props.onReplyAll(message)} title="Reply all (Shift+R)" aria-label="Reply all"><ReplyAll size={18} /></button>
          <button className="icon-button" onClick={() => props.onForward(message)} title="Forward (F)" aria-label="Forward"><Forward size={18} /></button>
        </div>
      </header>
      <article className="reader-content">
        <div className="subject-block">
          <h1 id="message-subject">{message.subject}</h1>
          <div className="subject-meta"><p className="identity-context"><span>Received for</span><strong>{props.identity?.email || "domain catch-all"}</strong></p><p className="thread-meta">{thread.length} {thread.length === 1 ? "message" : "messages"}</p></div>
        </div>
        <div className="thread-stack">
          {thread.map((item, index) => (
            <details className="thread-message" key={item.id} open={item.id === message.id || index === thread.length - 1}>
              <summary>
                <Avatar value={item.fromName || item.fromEmail} />
                <span className="thread-sender"><strong>{item.fromName || item.fromEmail}</strong><small>{item.fromEmail}</small></span>
                <span className="thread-respond-actions" onClick={(event) => event.preventDefault()}>
                  <button onClick={() => props.onReply(item)} title="Reply" aria-label={`Reply to ${item.fromName || item.fromEmail}`}><Reply size={16} /></button>
                  <button onClick={() => props.onReplyAll(item)} title="Reply all" aria-label={`Reply all to ${item.fromName || item.fromEmail}`}><ReplyAll size={16} /></button>
                  <button onClick={() => props.onForward(item)} title="Forward" aria-label={`Forward message from ${item.fromName || item.fromEmail}`}><Forward size={16} /></button>
                </span>
                <time>{fullDate(item.receivedAt)}</time>
                <ChevronDown size={16} className="detail-chevron" />
              </summary>
              <div className="recipient-line">To {item.to.map((address) => address.email).join(", ") || "undisclosed recipients"}</div>
              {item.hasHtmlBody ? <button className="text-button html-toggle" onClick={() => setShowHtml((current) => ({ ...current, [item.id]: !(current[item.id] ?? true) }))}>{(showHtml[item.id] ?? true) ? "Show plain text" : "Show formatted version"}</button> : null}
              {item.hasHtmlBody && (showHtml[item.id] ?? true) ? <FormattedMessage message={item} /> : <pre className="message-body">{item.textBody || "This message did not contain a readable plain-text body."}</pre>}
              {item.attachments.length ? (
                <div className="attachments" aria-label="Attachments">
                  {item.attachments.map((attachment) => (
                    isDocumentAttachment(attachment) ? (
                      <div className="attachment document-attachment" key={attachment.id}>
                        <button className="document-attachment-open" onClick={() => props.onOpenDocument(attachment)}>
                          <span className="attachment-document-icon">D</span>
                          <span><strong>{attachment.filename}</strong><small>Open in Documents · {formatBytes(attachment.sizeBytes)}</small></span>
                        </button>
                        <a className="attachment-download" href={`/api/attachments/${attachment.id}`} title="Download original attachment" aria-label={`Download ${attachment.filename}`}><Download size={16} /></a>
                      </div>
                    ) : isSpreadsheetAttachment(attachment) ? (
                      <div className="attachment document-attachment spreadsheet-attachment" key={attachment.id}>
                        <button className="document-attachment-open" onClick={() => props.onOpenSpreadsheet(attachment)}>
                          <span className="attachment-document-icon attachment-spreadsheet-icon">S</span>
                          <span><strong>{attachment.filename}</strong><small>Open in Spreadsheets · {formatBytes(attachment.sizeBytes)}</small></span>
                        </button>
                        <a className="attachment-download" href={`/api/attachments/${attachment.id}`} title="Download original attachment" aria-label={`Download ${attachment.filename}`}><Download size={16} /></a>
                      </div>
                    ) : (
                      <a className="attachment" href={`/api/attachments/${attachment.id}`} key={attachment.id}>
                        <File size={18} /><span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.sizeBytes)}</small></span><Download size={16} />
                      </a>
                    )
                  ))}
                </div>
              ) : null}
              {item.direction === "inbound" ? <a className="raw-link" href={`/api/messages/${item.id}/raw`}><Download size={14} /> Download original .eml</a> : null}
            </details>
          ))}
        </div>
        {props.labels.length ? <section className="reader-labels"><h2><Tag size={16} /> Labels</h2><div>{props.labels.map((label) => <label key={label.id}><input type="checkbox" checked={message.labels.some((item) => item.id === label.id)} onChange={(event) => props.onLabels(event.target.checked ? [...message.labels.map((item) => item.id), label.id] : message.labels.filter((item) => item.id !== label.id).map((item) => item.id))} /><span style={{ background: label.color }} />{label.name}</label>)}</div></section> : null}
        <div className="reader-response-bar" aria-label="Respond to conversation"><button className="button quiet" onClick={() => props.onReply(message)}><Reply size={17} /> Reply</button><button className="button quiet" onClick={() => props.onReplyAll(message)}><ReplyAll size={17} /> Reply all</button><button className="button quiet" onClick={() => props.onForward(message)}><Forward size={17} /> Forward</button></div>
      </article>
    </main>
  );
}

function FormattedMessage({ message }: { message: MessageDetail }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(520);
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  useEffect(() => {
    function resize(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; messageId?: string; height?: unknown } | null;
      if (data?.type !== "cfmail:email-height" || data.messageId !== message.id || typeof data.height !== "number") return;
      setHeight(Math.max(260, Math.min(2_400, Math.ceil(data.height))));
    }
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [message.id]);
  return <div className="message-html-wrap">
    {message.hasRemoteImages ? <div className={`remote-image-infobar ${showRemoteImages ? "loaded" : ""}`}>
      <ShieldCheck aria-hidden="true" />
      <span><strong>{showRemoteImages ? "Pictures loaded through cfmail" : "Some pictures were blocked to protect your privacy."}</strong><small>{showRemoteImages ? "Known tracking pixels remain blocked." : "Remote pictures can tell a sender that you opened this message."}</small></span>
      <button onClick={() => { setHeight(520); setShowRemoteImages((value) => !value); }}>{showRemoteImages ? "Hide pictures" : "Show pictures"}</button>
    </div> : null}
    <iframe
      ref={frameRef}
      className="message-html"
      style={{ height }}
      title={`Formatted version of ${message.subject}`}
      src={`/api/messages/${message.id}/html${showRemoteImages ? "?remoteImages=1" : ""}`}
      sandbox={EMAIL_VIEWER_SANDBOX}
    />
  </div>;
}

interface ComposeSeed { mode: "compose" | "reply" | "replyAll" | "forward"; message?: MessageDetail; draft?: DraftRecord }

function Composer(props: {
  seed: ComposeSeed;
  domains: DomainRecord[];
  identities: IdentityRecord[];
  onClose: () => void;
  onSent: (scheduled: { id: string; sendAfter: string }) => void;
}) {
  const sourceMessage = props.seed.message;
  const isReply = props.seed.mode === "reply" || props.seed.mode === "replyAll";
  const replyMessage = isReply ? sourceMessage : undefined;
  const recoveredDraft = props.seed.draft;
  const suggestedIdentity =
    props.identities.find((identity) => identity.id === recoveredDraft?.identityId) ||
    props.identities.find((identity) => identity.id === sourceMessage?.identityId) ||
    (sourceMessage ? props.identities.find((identity) => identity.domainId === sourceMessage.domainId) : undefined);
  const managedEmails = new Set(props.identities.map((identity) => identity.email.toLowerCase()));
  const responseAddresses = sourceMessage
    ? sourceMessage.direction === "inbound"
      ? [sourceMessage.replyToEmail || sourceMessage.fromEmail, ...sourceMessage.to.map((address) => address.email), ...sourceMessage.cc.map((address) => address.email)]
      : [...sourceMessage.to.map((address) => address.email), ...sourceMessage.cc.map((address) => address.email)]
    : [];
  const replyAllAddresses = Array.from(new Set(responseAddresses.map((email) => email.toLowerCase()))).filter((email) => !managedEmails.has(email));
  const primaryReplyAddress = replyAllAddresses[0] || (sourceMessage ? sourceMessage.replyToEmail || sourceMessage.fromEmail : "");
  const forwardedBody = sourceMessage ? `\n\n---------- Forwarded message ----------\nFrom: ${sourceMessage.fromName ? `${sourceMessage.fromName} <${sourceMessage.fromEmail}>` : sourceMessage.fromEmail}\nDate: ${fullDate(sourceMessage.receivedAt)}\nSubject: ${sourceMessage.subject}\nTo: ${sourceMessage.to.map((address) => address.email).join(", ")}\n\n${sourceMessage.textBody}` : "";
  const [identityId, setIdentityId] = useState(suggestedIdentity?.id || "");
  const [to, setTo] = useState(recoveredDraft?.to.join(", ") || (props.seed.mode === "replyAll" ? replyAllAddresses.join(", ") : props.seed.mode === "reply" ? primaryReplyAddress : ""));
  const [cc, setCc] = useState(recoveredDraft?.cc.join(", ") || "");
  const [bcc, setBcc] = useState(recoveredDraft?.bcc.join(", ") || "");
  const [showCopies, setShowCopies] = useState(Boolean(recoveredDraft?.cc.length || recoveredDraft?.bcc.length));
  const [subject, setSubject] = useState(recoveredDraft?.subject || (sourceMessage ? props.seed.mode === "forward" ? (/^fwd\s*:/i.test(sourceMessage.subject) ? sourceMessage.subject : `Fwd: ${sourceMessage.subject}`) : (/^re\s*:/i.test(sourceMessage.subject) ? sourceMessage.subject : `Re: ${sourceMessage.subject}`) : ""));
  const [body, setBody] = useState(recoveredDraft?.textBody || (props.seed.mode === "forward" ? forwardedBody : ""));
  const [draftId, setDraftId] = useState<string>(recoveredDraft?.id || crypto.randomUUID());
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [uploads, setUploads] = useState<UploadRecord[]>(() => (recoveredDraft?.attachmentIds || []).map((id) => ({ id, filename: "Saved attachment", mimeType: "application/octet-stream", sizeBytes: 0 })));
  const [contacts, setContacts] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const selectedIdentity = props.identities.find((identity) => identity.id === identityId);
  const crossDomain = Boolean(isReply && sourceMessage && selectedIdentity && selectedIdentity.domainId !== sourceMessage.domainId);

  useEffect(() => bodyRef.current?.focus(), []);
  useEffect(() => { void mailApi.contacts().then((result) => setContacts(result.contacts.map((contact) => contact.email))).catch(() => undefined); }, []);

  useEffect(() => {
    if (!identityId && !to && !subject && !body) return;
    setSaveState("saving");
    const timeout = window.setTimeout(() => {
      mailApi
        .saveDraft({
          id: draftId,
          identityId: identityId || null,
          threadId: replyMessage?.threadId || null,
          replyToMessageId: replyMessage?.id || recoveredDraft?.replyToMessageId || null,
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          subject,
          textBody: body,
          attachmentIds: uploads.map((upload) => upload.id),
        })
        .then((saved) => {
          setDraftId(saved.id);
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [bcc, body, cc, draftId, identityId, replyMessage?.threadId, subject, to, uploads]);

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setError("");
    try { const result = await mailApi.upload(Array.from(files)); setUploads((current) => [...current, ...result.uploads]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Attachments could not be uploaded"); }
    finally { setUploading(false); }
  }

  function wrapSelection(before: string, after = before) {
    const field = bodyRef.current;
    if (!field) return;
    const start = field.selectionStart; const end = field.selectionEnd;
    setBody(`${body.slice(0, start)}${before}${body.slice(start, end)}${after}${body.slice(end)}`);
    window.setTimeout(() => { field.focus(); field.setSelectionRange(start + before.length, end + before.length); });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (crossDomain && !confirmIdentity) {
      setError("Confirm the cross-domain sending identity before sending.");
      return;
    }
    setError("");
    setSending(true);
    try {
      const scheduled = await mailApi.send({
        identityId,
        to: splitAddresses(to),
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
        subject,
        textBody: body,
        replyToMessageId: replyMessage?.id || recoveredDraft?.replyToMessageId || null,
        confirmCrossDomain: confirmIdentity,
        attachmentIds: uploads.map((upload) => upload.id),
        clientRequestId: draftId,
      });
      await mailApi.deleteDraft(draftId).catch(() => undefined);
      props.onSent({ id: scheduled.id, sendAfter: scheduled.sendAfter });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message could not be sent");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="dialog-layer" role="presentation">
      <button className="dialog-scrim" onClick={props.onClose} aria-hidden="true" tabIndex={-1} />
      <section className="composer" role="dialog" aria-modal="true" aria-labelledby="compose-heading">
        <header className="composer-header">
          <div><p className="eyebrow">{props.seed.mode === "compose" ? "New message" : "Continue conversation"}</p><h2 id="compose-heading">{props.seed.mode === "replyAll" ? "Reply all" : props.seed.mode === "forward" ? "Forward" : props.seed.mode === "reply" ? "Reply" : "Compose"}</h2></div>
          <button className="icon-button" onClick={props.onClose} aria-label="Close composer"><X /></button>
        </header>
        <form onSubmit={sendMessage} className="composer-form">
          <div className="compose-field identity-field">
            <label htmlFor="compose-from">From</label>
            <select id="compose-from" value={identityId} onChange={(event) => { setIdentityId(event.target.value); setConfirmIdentity(false); }} required>
              <option value="" disabled>Choose a sending identity</option>
              {props.identities.filter((identity) => props.domains.find((domain) => domain.id === identity.domainId)?.outboundEnabled).map((identity) => (
                <option value={identity.id} key={identity.id}>{identity.displayName ? `${identity.displayName} — ` : ""}{identity.email}</option>
              ))}
            </select>
          </div>
          {crossDomain ? (
            <label className="identity-warning"><input type="checkbox" checked={confirmIdentity} onChange={(event) => setConfirmIdentity(event.target.checked)} /><span><strong>Different sending domain</strong>This reply was received on another domain. Confirm that {selectedIdentity?.email} is intentional.</span></label>
          ) : null}
          <div className="compose-field address-field">
            <label htmlFor="compose-to">To</label>
            <input id="compose-to" type="text" list="known-contacts" value={to} onChange={(event) => setTo(event.target.value)} required />
            <datalist id="known-contacts">{contacts.map((contact) => <option key={contact} value={contact} />)}</datalist>
            <button type="button" className="text-button" onClick={() => setShowCopies((value) => !value)}>Cc/Bcc</button>
          </div>
          {showCopies ? (
            <>
              <div className="compose-field"><label htmlFor="compose-cc">Cc</label><input id="compose-cc" type="text" value={cc} onChange={(event) => setCc(event.target.value)} /></div>
              <div className="compose-field"><label htmlFor="compose-bcc">Bcc</label><input id="compose-bcc" type="text" value={bcc} onChange={(event) => setBcc(event.target.value)} /></div>
            </>
          ) : null}
          <div className="compose-field"><label htmlFor="compose-subject">Subject</label><input id="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></div>
          <div className="format-toolbar" aria-label="Formatting tools"><button type="button" onClick={() => wrapSelection("**")} title="Bold"><Bold size={16} /></button><button type="button" onClick={() => wrapSelection("_")} title="Italic"><Italic size={16} /></button><button type="button" onClick={() => wrapSelection("[", "](https://)")} title="Link">Link</button></div>
          <label className="sr-only" htmlFor="compose-body">Message</label>
          <textarea ref={bodyRef} id="compose-body" className="compose-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your message…" required />
          <div className="upload-row"><label className="button quiet"><UploadCloud size={17} /> {uploading ? "Uploading…" : "Attach files"}<input type="file" multiple hidden disabled={uploading} onChange={(event) => void attachFiles(event.target.files)} /></label><span>Up to 10 files, 20 MiB total</span></div>
          {uploads.length ? <div className="compose-attachments">{uploads.map((upload) => <span key={upload.id}><Paperclip size={14} />{upload.filename}{upload.sizeBytes ? ` · ${formatBytes(upload.sizeBytes)}` : ""}<button type="button" onClick={() => setUploads((current) => current.filter((item) => item.id !== upload.id))} aria-label={`Remove ${upload.filename}`}><X size={13} /></button></span>)}</div> : null}
          {error ? <p className="form-error compose-error" role="alert">{error}</p> : null}
          <footer className="composer-footer">
            <span className={`draft-state ${saveState}`} aria-live="polite">{saveState === "saving" ? "Saving draft…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved" : ""}</span>
            <div className="composer-actions"><button type="button" className="button quiet danger" onClick={async () => { await mailApi.deleteDraft(draftId).catch(() => undefined); props.onClose(); }}><Trash2 size={16} /> Discard draft</button><button className="button primary" disabled={sending || !identityId}><Send size={17} /> {sending ? "Sending…" : "Send message"}</button></div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function DraftsPane({ identities, domain, onCompose }: { identities: IdentityRecord[]; domain: DomainRecord | null; onCompose: (draft: DraftRecord) => void | Promise<void> }) {
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDrafts((await mailApi.drafts()).drafts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Drafts could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const identityDomainById = useMemo(() => new Map(identities.map((identity) => [identity.id, identity.domainId])), [identities]);
  const visibleDrafts = domain ? drafts.filter((draft) => draft.identityId && identityDomainById.get(draft.identityId) === domain.id) : drafts;

  async function remove(id: string) {
    try {
      await mailApi.deleteDraft(id);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Draft could not be deleted");
    }
  }

  return (
    <main className="drafts-pane" aria-labelledby="drafts-heading">
      <header className="settings-header">
        <p className="eyebrow">Work in progress</p>
        <h1 id="drafts-heading">{domain ? `${domain.label} drafts` : "Drafts"}</h1>
        <p>{domain ? `Drafts using a ${domain.name} sending identity.` : "Messages save automatically while you write. Open a draft to continue from where you left off."}</p>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading ? <MessageSkeleton /> : null}
      {!loading && !visibleDrafts.length ? <EmptyState icon={FileText} title={domain ? `No drafts for ${domain.label}` : "No saved drafts"} copy={domain ? `Drafts sent from ${domain.name} will appear here.` : "Start a message and it will appear here automatically."} /> : null}
      <div className="draft-list">
        {visibleDrafts.map((draft) => {
          const identity = identities.find((item) => item.id === draft.identityId);
          return (
            <article className="draft-card" key={draft.id}>
              <button className="draft-open" onClick={() => void onCompose(draft)}>
                <span className="draft-topline"><strong>{draft.subject || "(no subject)"}</strong><time>{fullDate(draft.updatedAt)}</time></span>
                <span className="draft-address">From {identity?.email || "identity not selected"} · To {draft.to.join(", ") || "recipient not selected"}</span>
                <span className="draft-preview">{makeDraftPreview(draft.textBody)}</span>
              </button>
              <button className="button quiet danger" onClick={() => void remove(draft.id)}><Trash2 size={16} /> Delete</button>
            </article>
          );
        })}
      </div>
    </main>
  );
}

function DomainSettings({ bootstrap, onChanged }: { bootstrap: MailboxBootstrap | null; onChanged: () => Promise<void> }) {
  const [section, setSection] = useState<"domains" | "identities" | "mailbox" | "activity">("domains");
  const [adding, setAdding] = useState<"domain" | "identity" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [warning, setWarning] = useState("");
  const [storage, setStorage] = useState<Record<string, { messages: number; rawBytes: number; attachmentBytes: number }>>({});
  const [audit, setAudit] = useState<Array<{ id: string; action: string; actorEmail: string; createdAt: string }>>([]);
  const [delivery, setDelivery] = useState<Array<{ domainId: string; status: string; count: number }>>([]);

  useEffect(() => {
    void Promise.all([mailApi.audit(), mailApi.delivery()]).then(([auditResult, deliveryResult]) => {
      setAudit(auditResult.entries);
      setDelivery(deliveryResult.summary);
    }).catch(() => undefined);
    for (const domain of bootstrap?.domains || []) {
      void mailApi.domainStorage(domain.id).then((value) => setStorage((current) => ({ ...current, [domain.id]: value }))).catch(() => undefined);
    }
  }, [bootstrap?.domains]);

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(""); setSuccess(""); setWarning("");
    try {
      await mailApi.addDomain({
        name: String(data.get("name")),
        label: String(data.get("label")),
        inboundEnabled: data.get("inbound") === "on",
        outboundEnabled: data.get("outbound") === "on",
      });
      form.reset();
      await onChanged();
      setAdding(null);
      setSuccess("Domain added to cfmail. Configure its Email Routing and Email Sending records before use.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add domain"); }
  }

  async function addIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(""); setSuccess(""); setWarning("");
    try {
      const { routing } = await mailApi.addIdentity({
        domainId: String(data.get("domainId")),
        email: String(data.get("email")),
        displayName: String(data.get("displayName")),
        isDefault: data.get("default") === "on",
        signatureText: String(data.get("signatureText") || ""),
        signatureHtml: String(data.get("signatureHtml") || ""),
      });
      form.reset();
      await onChanged();
      setAdding(null);
      if (routing === "created") setSuccess("Identity added and its Email Routing rule was created in Cloudflare.");
      else if (routing === "existing") setSuccess("Identity added. Cloudflare already routes this address to cfmail.");
      else if (routing === "inbound_disabled") setSuccess("Identity added for sending only. Inbound mail is disabled for this domain.");
      else setWarning("Identity added, but no Email Routing rule was created because CF_API_TOKEN is not set. Add a Cloudflare routing rule that sends this address to the cfmail Worker, or mail to it will not arrive.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add identity"); }
  }

  const settingsSections = [
    { id: "domains" as const, label: "Domains", icon: AtSign },
    { id: "identities" as const, label: "Sending identities", icon: Users },
    { id: "mailbox" as const, label: "Mailbox", icon: Database },
    { id: "activity" as const, label: "Delivery & activity", icon: Activity },
  ];

  return (
    <main className="settings-pane" aria-labelledby="settings-heading">
      <header className="settings-titlebar">
        <div><h1 id="settings-heading">Settings</h1><p>Manage domains, sender identities, and mailbox storage.</p></div>
      </header>
      <div className="settings-workspace">
        <nav className="settings-nav" aria-label="Settings categories">
          <p>Mail settings</p>
          {settingsSections.map(({ id, label, icon: Icon }) => (
            <button key={id} className={section === id ? "active" : ""} onClick={() => { setSection(id); setAdding(null); }}><Icon size={17} /><span>{label}</span></button>
          ))}
        </nav>

        <div className="settings-content">
          {error ? <p className="settings-notice error" role="alert">{error}</p> : null}
          {success ? <p className="settings-notice success" role="status">{success}</p> : null}
          {warning ? <p className="settings-notice warning" role="status">{warning}</p> : null}

          {section === "domains" ? (
            <section aria-labelledby="configured-domains">
              <header className="settings-section-header"><div><h2 id="configured-domains">Domains</h2><p>Domains that receive and send mail through cfmail.</p></div><button className="button primary" onClick={() => setAdding(adding === "domain" ? null : "domain")}>{adding === "domain" ? <X size={16} /> : <AtSign size={16} />}{adding === "domain" ? "Close" : "Add domain"}</button></header>
              {adding === "domain" ? <div className="settings-editor-panel"><h3>Add a domain</h3><form onSubmit={addDomain} className="settings-form settings-form-columns"><label>Domain name<input name="name" type="text" placeholder="example.com" required /></label><label>Display name<input name="label" type="text" placeholder="Example" required /></label><label className="check-row"><input type="checkbox" name="inbound" /><span><strong>Receiving configured</strong>Email Routing points to this Worker.</span></label><label className="check-row"><input type="checkbox" name="outbound" /><span><strong>Sending configured</strong>Email Sending is authenticated.</span></label><div className="settings-form-actions"><button className="button primary">Add domain</button><button type="button" className="button quiet" onClick={() => setAdding(null)}>Cancel</button></div></form><div className="infra-note"><ShieldCheck size={17} /><p><strong>DNS stays under your control.</strong>Adding a domain here does not change DNS. Complete the repository onboarding steps before enabling mail flow.</p></div></div> : null}
              <div className="settings-list domain-settings-list" role="list">
                <div className="settings-list-heading" aria-hidden="true"><span>Domain</span><span>Status</span><span>Storage</span><span>Actions</span></div>
                {bootstrap?.domains.map((domain) => <article className="settings-list-row domain-settings-row" key={domain.id}><div className="settings-primary"><span className="domain-monogram">{domain.label.slice(0, 1).toUpperCase()}</span><span><strong>{domain.label}</strong><small>{domain.name}</small></span></div><div className="domain-statuses"><StatusPill ready={domain.inboundEnabled} label="Receive" /><StatusPill ready={domain.outboundEnabled} label="Send" /><StatusPill ready={[domain.health.spf, domain.health.dkim, domain.health.dmarc].every((value) => value === "healthy")} label="DNS" /></div><small className="storage-summary">{storage[domain.id] ? `${storage[domain.id].messages} messages · ${formatBytes(storage[domain.id].rawBytes + storage[domain.id].attachmentBytes)}` : "Calculating…"}</small><button className="button quiet compact-button" onClick={async () => { setError(""); setSuccess(""); setWarning(""); try { await mailApi.domainHealth(domain.id); await onChanged(); setSuccess(`${domain.name} DNS health refreshed.`); } catch (caught) { setError(caught instanceof Error ? caught.message : "Health check failed"); } }}><RefreshCw size={14} /> Check DNS</button></article>)}
                {!bootstrap?.domains.length ? <EmptyState icon={AtSign} title="No domains yet" copy="Add the first domain to begin." /> : null}
              </div>
            </section>
          ) : null}

          {section === "identities" ? (
            <SendingIdentitiesSettings
              domains={bootstrap?.domains || []}
              identities={bootstrap?.identities || []}
              adding={adding === "identity"}
              onToggleAdding={() => setAdding(adding === "identity" ? null : "identity")}
              onCancelAdding={() => setAdding(null)}
              onAdd={addIdentity}
              onChanged={onChanged}
              onError={setError}
              onSuccess={setSuccess}
            />
          ) : null}

          {section === "mailbox" ? (
            <section aria-labelledby="mailbox-settings-heading"><header className="settings-section-header"><div><h2 id="mailbox-settings-heading">Mailbox</h2><p>Delivery safeguards, retention, backups, and message labels.</p></div></header><div className="settings-group"><h3>Retention and backups</h3><form className="retention-form" onSubmit={async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setError(""); setSuccess(""); setWarning(""); try { await mailApi.updateSettings({ undoSendSeconds: Number(data.get("undo")), trashRetentionDays: Number(data.get("trash")), backupRetentionDays: Number(data.get("backup")) }); await onChanged(); setSuccess("Mailbox retention settings updated."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Settings could not be updated"); } }}><label>Undo send (seconds)<input name="undo" type="number" min="0" max="60" defaultValue={bootstrap?.settings.undoSendSeconds} /></label><label>Trash retention (days)<input name="trash" type="number" min="1" max="3650" defaultValue={bootstrap?.settings.trashRetentionDays} /></label><label>Backup retention (days)<input name="backup" type="number" min="7" max="3650" defaultValue={bootstrap?.settings.backupRetentionDays} /></label><button className="button primary"><Save size={15} /> Save changes</button></form><p className="settings-help">Daily logical D1 backups are written to R2 and expired automatically.</p></div><div className="settings-group"><h3>Labels</h3><div className="label-list">{bootstrap?.labels.map((label) => <span key={label.id}><i style={{ background: label.color }} />{label.name}</span>)}</div><form className="label-form" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); try { await mailApi.addLabel(String(data.get("name")), String(data.get("color"))); form.reset(); await onChanged(); setSuccess("Label added."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Label could not be added"); } }}><input name="name" placeholder="New label" required /><input name="color" type="color" defaultValue="#64748b" aria-label="Label colour" /><button className="button quiet">Add label</button></form></div></section>
          ) : null}

          {section === "activity" ? (
            <section aria-labelledby="activity-heading"><header className="settings-section-header"><div><h2 id="activity-heading">Delivery & activity</h2><p>Recent outbound results and administrative changes.</p></div></header><div className="settings-group"><h3>Outbound delivery</h3>{delivery.length ? <div className="metric-list">{delivery.map((item) => <div key={`${item.domainId}-${item.status}`}><span>{bootstrap?.domains.find((domain) => domain.id === item.domainId)?.name || item.domainId}</span><span className="delivery-status">{item.status}</span><strong>{item.count}</strong></div>)}</div> : <p className="settings-help">No outbound delivery events yet.</p>}</div><div className="settings-group"><h3>Recent activity</h3><div className="audit-list">{audit.slice(0, 24).map((entry) => <div key={entry.id}><strong>{entry.action.replaceAll(".", " ")}</strong><span>{entry.actorEmail}</span><time>{fullDate(entry.createdAt)}</time></div>)}</div></div></section>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function SendingIdentitiesSettings(props: {
  domains: DomainRecord[];
  identities: IdentityRecord[];
  adding: boolean;
  onToggleAdding: () => void;
  onCancelAdding: () => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  return (
    <section aria-labelledby="identities-heading">
      <header className="settings-section-header">
        <div><h2 id="identities-heading">Sending identities</h2><p>Names, addresses, and signatures available when composing mail.</p></div>
        <button className="button primary" onClick={props.onToggleAdding}>{props.adding ? <X size={16} /> : <PenLine size={16} />}{props.adding ? "Close" : "Add identity"}</button>
      </header>

      {props.adding ? (
        <div className="settings-editor-panel identity-add-panel">
          <h3>Add a sending identity</h3>
          <form onSubmit={props.onAdd} className="settings-form identity-add-form">
            <div className="identity-add-grid">
              <label>Domain<select name="domainId" required><option value="">Choose a domain</option>{props.domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
              <label>Email address<input name="email" type="email" placeholder="hello@example.com" required /></label>
              <label>Display name<input name="displayName" type="text" placeholder="Example team" /></label>
              <label className="identity-default-check"><input type="checkbox" name="default" /><span>Default</span></label>
            </div>
            <SignatureFields id="new-identity-signature" />
            <div className="settings-form-actions"><button className="button primary">Add identity</button><button type="button" className="button quiet" onClick={props.onCancelAdding}>Cancel</button></div>
          </form>
        </div>
      ) : null}

      <div className="identity-domain-groups">
        {props.domains.map((domain) => {
          const identities = props.identities.filter((identity) => identity.domainId === domain.id);
          return (
            <details className="identity-domain-group" aria-labelledby={`identity-domain-${domain.id}`} key={domain.id}>
              <summary className="identity-domain-header">
                <span className="domain-monogram">{domain.label.slice(0, 1).toUpperCase()}</span>
                <span><h3 id={`identity-domain-${domain.id}`}>{domain.label}</h3><p>{domain.name}</p></span>
                <span className="identity-domain-count">{identities.length} {identities.length === 1 ? "identity" : "identities"}</span>
                <ChevronDown className="identity-domain-chevron" size={17} aria-hidden="true" />
              </summary>
              <div className="identity-list">
                {identities.map((identity) => (
                  <IdentityEditor
                    identity={identity}
                    key={identity.id}
                    onChanged={props.onChanged}
                    onError={props.onError}
                    onSuccess={props.onSuccess}
                  />
                ))}
                {!identities.length ? <p className="identity-empty-row">No sending identities for this domain.</p> : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function IdentityEditor(props: {
  identity: IdentityRecord;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const { identity } = props;
  const hasSignature = Boolean(identity.signatureText.trim() || identity.signatureHtml.trim());

  return (
    <details className="identity-editor">
      <summary className="identity-row">
        <Avatar value={identity.email} />
        <span><strong>{identity.displayName || "Unnamed identity"}</strong><small>{identity.email}</small></span>
        {hasSignature ? <span className="signature-pill">{identity.signatureHtml.trim() ? "HTML + text" : "Text signature"}</span> : null}
        {identity.isDefault ? <span className="default-pill">Default</span> : null}
        <ChevronDown size={16} />
      </summary>
      <form className="inline-settings identity-update-form" onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        props.onError("");
        props.onSuccess("");
        try {
          await mailApi.updateIdentity(identity.id, {
            displayName: String(data.get("displayName")),
            signatureText: String(data.get("signatureText") || ""),
            signatureHtml: String(data.get("signatureHtml") || ""),
            isDefault: data.get("default") === "on",
          });
          await props.onChanged();
          props.onSuccess(`${identity.email} updated.`);
        } catch (caught) {
          props.onError(caught instanceof Error ? caught.message : "Identity could not be updated");
        }
      }}>
        <div className="identity-update-basics">
          <label>Display name<input name="displayName" defaultValue={identity.displayName} /></label>
          <label className="identity-default-check"><input name="default" type="checkbox" defaultChecked={identity.isDefault} /><span>Default</span></label>
        </div>
        <SignatureFields id={`identity-signature-${identity.id}`} signatureText={identity.signatureText} signatureHtml={identity.signatureHtml} />
        <div className="identity-editor-actions"><button className="button primary"><Save size={15} /> Save changes</button></div>
      </form>
    </details>
  );
}

function SignatureFields(props: { id: string; signatureText?: string; signatureHtml?: string }) {
  const [open, setOpen] = useState(false);
  const hasSignature = Boolean(props.signatureText?.trim() || props.signatureHtml?.trim());

  return (
    <div className="signature-fields">
      <button type="button" className="signature-toggle" aria-expanded={open} aria-controls={props.id} onClick={() => setOpen((value) => !value)}>
        <FileText size={17} />
        <span><strong>{hasSignature ? "Edit signature" : "Add signature"}</strong><small>Plain text and HTML versions</small></span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className="signature-editor-fields" id={props.id} hidden={!open}>
        <label>Plain-text signature<textarea name="signatureText" defaultValue={props.signatureText} rows={7} placeholder={'Your name\nCompany'} /></label>
        <label>HTML signature<textarea name="signatureHtml" className="signature-html-input" defaultValue={props.signatureHtml} rows={7} placeholder={'<strong>Your name</strong>\n<span>Company</span>'} spellCheck={false} /></label>
        <p>Both versions are sent together. Email clients choose the format they support.</p>
      </div>
    </div>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`} aria-label="cfmail"><span className="brand-icon"><Mail size={compact ? 18 : 22} /></span><span>cf<span>mail</span></span></div>;
}

function Avatar({ value }: { value: string }) { return <span className="avatar" aria-hidden="true">{value.slice(0, 1).toUpperCase()}</span>; }
function StatusPill({ ready, label }: { ready: boolean; label: string }) { return <span className={`status-pill ${ready ? "ready" : "pending"}`}>{ready ? <Check size={13} /> : <MoreHorizontal size={13} />}{label}</span>; }
function EmptyState({ icon: Icon, title, copy }: { icon: typeof Inbox; title: string; copy: string }) { return <div className="empty-state"><span><Icon /></span><h2>{title}</h2><p>{copy}</p></div>; }
function MessageSkeleton() { return <div className="skeleton-list" aria-label="Loading messages">{Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><i /><span><b /><b /></span></div>)}</div>; }
function MessageReaderSkeleton() { return <div className="reader-skeleton" aria-label="Loading message"><i /><i /><i /><i /></div>; }
function folderLabel(folder: Folder) { return folder.slice(0, 1).toUpperCase() + folder.slice(1); }
function relativeDate(value: string) { const date = new Date(value); const today = new Date(); return date.toDateString() === today.toDateString() ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); }
function fullDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function folderCount(bootstrap: MailboxBootstrap | null, domainId: string | null, folder: Folder) { return (bootstrap?.counts || []).filter((count) => count.folder === folder && (!domainId || count.domainId === domainId)).reduce((total, count) => total + (folder === "inbox" ? count.unread : count.total), 0); }
function splitAddresses(value: string) { return Array.from(new Set(value.split(/[;,]/).map((part) => part.trim().toLowerCase()).filter(Boolean))); }
function makeDraftPreview(value: string) { return value.replace(/\s+/g, " ").trim().slice(0, 180) || "Empty message"; }
