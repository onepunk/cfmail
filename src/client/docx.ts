import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IParagraphOptions,
  type IRunStylePropertiesOptions,
  type ParagraphChild,
} from "docx";
import type { DocumentPageSettings } from "../shared/types";

const FONT_SIZE_MAP: Record<string, number> = {
  "1": 16,
  "2": 20,
  "3": 24,
  "4": 28,
  "5": 36,
  "6": 48,
  "7": 72,
};

export async function exportDocx(title: string, html: string, page: DocumentPageSettings): Promise<void> {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const root = parsed.querySelector("main");
  const children = root ? blockChildren(root) : [new Paragraph("")];
  const dimensions = pageDimensions(page);
  const margins = pageMargins(page.margins);
  const file = new Document({
    title,
    creator: "cfmail Documents",
    lastModifiedBy: "cfmail Documents",
    numbering: {
      config: [{
        reference: "cfmail-numbered-list",
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
        })),
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: dimensions.width, height: dimensions.height, orientation: page.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: margins,
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(file);
  downloadBlob(blob, `${safeDocumentName(title)}.docx`);
}

function blockChildren(root: Element): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent?.trim();
      if (value) blocks.push(new Paragraph({ children: [new TextRun(value)] }));
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") {
      blocks.push(tableFromElement(node));
    } else if (tag === "ul" || tag === "ol") {
      blocks.push(...listParagraphs(node, 0, tag === "ol"));
    } else if (["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"].includes(tag)) {
      blocks.push(paragraphFromElement(node));
    } else if (tag === "hr") {
      blocks.push(new Paragraph({ children: [new TextRun("────────────────────────────────")] }));
    } else {
      blocks.push(new Paragraph({ children: inlineChildren(node, {}) }));
    }
  }
  return blocks.length ? blocks : [new Paragraph("")];
}

function paragraphFromElement(element: HTMLElement): Paragraph {
  const tag = element.tagName.toLowerCase();
  const heading = headingLevel(tag);
  const options: IParagraphOptions = {
    children: inlineChildren(element, {}),
    heading,
    alignment: alignment(element),
    indent: tag === "blockquote" ? { left: 720 } : undefined,
    spacing: { after: tag.startsWith("h") ? 180 : 120, line: 276 },
  };
  return new Paragraph(options);
}

function listParagraphs(list: HTMLElement, level: number, numbered: boolean): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== "li") continue;
    const inlineHost = item.cloneNode(true) as HTMLElement;
    inlineHost.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => nested.remove());
    paragraphs.push(new Paragraph({
      children: inlineChildren(inlineHost, {}),
      ...(numbered ? { numbering: { reference: "cfmail-numbered-list", level: Math.min(level, 8) } } : { bullet: { level: Math.min(level, 8) } }),
      spacing: { after: 60 },
    }));
    for (const nested of Array.from(item.children)) {
      const tag = nested.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") paragraphs.push(...listParagraphs(nested as HTMLElement, level + 1, tag === "ol"));
    }
  }
  return paragraphs;
}

function tableFromElement(element: HTMLElement): Table {
  const rows = Array.from(element.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr"));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row) => new TableRow({
      children: Array.from(row.children)
        .filter((cell) => ["td", "th"].includes(cell.tagName.toLowerCase()))
        .map((cell) => new TableCell({
          shading: cell.tagName.toLowerCase() === "th" ? { fill: "E9EFF7" } : undefined,
          children: [new Paragraph({ children: inlineChildren(cell as HTMLElement, cell.tagName.toLowerCase() === "th" ? { bold: true } : {}) })],
        })),
    })),
  });
}

function inlineChildren(element: HTMLElement, inherited: IRunStylePropertiesOptions): ParagraphChild[] {
  const output: ParagraphChild[] = [];
  const own = mergeFormat(inherited, element);
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) output.push(new TextRun({ text: node.textContent, ...own }));
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      output.push(new TextRun({ break: 1 }));
    } else if (tag === "a" && node.getAttribute("href")) {
      output.push(new ExternalHyperlink({
        link: node.getAttribute("href") || "",
        children: inlineChildren(node, { ...own, color: "0563C1", underline: { type: UnderlineType.SINGLE } }),
      }));
    } else if (tag === "img") {
      output.push(new TextRun({ text: `[Image: ${node.getAttribute("alt") || "picture"}]`, italics: true, color: "64748B" }));
    } else if (tag !== "ul" && tag !== "ol" && tag !== "table") {
      output.push(...inlineChildren(node, own));
    }
  }
  return output.length ? output : [new TextRun("")];
}

function mergeFormat(inherited: IRunStylePropertiesOptions, element: HTMLElement): IRunStylePropertiesOptions {
  const tag = element.tagName.toLowerCase();
  const style = element.style;
  const color = cssColorToHex(style.color || element.getAttribute("color") || "");
  const pointSize = parsePointSize(style.fontSize) || FONT_SIZE_MAP[element.getAttribute("size") || ""];
  return {
    ...inherited,
    bold: inherited.bold || tag === "strong" || tag === "b" || Number(style.fontWeight) >= 600,
    italics: inherited.italics || tag === "em" || tag === "i" || style.fontStyle === "italic",
    underline: inherited.underline || tag === "u" || style.textDecorationLine.includes("underline") ? { type: UnderlineType.SINGLE } : undefined,
    strike: inherited.strike || tag === "s" || tag === "strike" || style.textDecorationLine.includes("line-through"),
    subScript: inherited.subScript || tag === "sub",
    superScript: inherited.superScript || tag === "sup",
    color: color || inherited.color,
    size: pointSize ? Math.round(pointSize * 2) : inherited.size,
    font: style.fontFamily ? style.fontFamily.replace(/["']/g, "").split(",")[0] : inherited.font,
  };
}

function headingLevel(tag: string) {
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;
  const match = /^h([1-6])$/.exec(tag);
  return match ? levels[Number(match[1]) - 1] : undefined;
}

function alignment(element: HTMLElement) {
  const value = element.style.textAlign || element.getAttribute("align") || "";
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right" || value === "end") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  return AlignmentType.LEFT;
}

function parsePointSize(value: string): number | undefined {
  const match = /^([\d.]+)(pt|px)$/.exec(value.trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  return match[2] === "px" ? number * 0.75 : number;
}

function cssColorToHex(value: string): string | undefined {
  if (/^#[\da-f]{6}$/i.test(value)) return value.slice(1).toUpperCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(value);
  if (!rgb) return undefined;
  return rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function pageDimensions(page: DocumentPageSettings) {
  const portrait = page.size === "a4" ? { width: 11_906, height: 16_838 } : { width: 12_240, height: 15_840 };
  return page.orientation === "landscape" ? { width: portrait.height, height: portrait.width } : portrait;
}

function pageMargins(value: DocumentPageSettings["margins"]) {
  if (value === "narrow") return { top: 720, right: 720, bottom: 720, left: 720 };
  if (value === "wide") return { top: 1440, right: 2880, bottom: 1440, left: 2880 };
  return { top: 1440, right: 1440, bottom: 1440, left: 1440 };
}

function safeDocumentName(value: string): string {
  return (value || "Untitled document").replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 120) || "Untitled document";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
