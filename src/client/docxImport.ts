import JSZip from "jszip";
import type { DocumentPageSettings } from "../shared/types";

type CSSValue = string | number | boolean | undefined;
type Format = Record<string, CSSValue>;

interface StyleDefinition {
  id: string;
  name: string;
  basedOn: string;
  paragraph: Format;
  run: Format;
}

interface ImportResult {
  html: string;
  plainText: string;
  page: DocumentPageSettings;
  warnings: string[];
}

const HIGHLIGHTS: Record<string, string> = {
  black: "#000000", blue: "#0000ff", cyan: "#00ffff", darkBlue: "#000080", darkCyan: "#008080",
  darkGray: "#808080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", green: "#00ff00", lightGray: "#c0c0c0", magenta: "#ff00ff",
  red: "#ff0000", white: "#ffffff", yellow: "#ffff00",
};

export async function importDocxRich(arrayBuffer: ArrayBuffer): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const [documentXml, stylesXml, relationshipsXml] = await Promise.all([
    zip.file("word/document.xml")?.async("string"),
    zip.file("word/styles.xml")?.async("string"),
    zip.file("word/_rels/document.xml.rels")?.async("string"),
  ]);
  if (!documentXml) throw new Error("The .docx file has no document body");
  const parser = new DOMParser();
  const documentDom = parser.parseFromString(documentXml, "application/xml");
  if (documentDom.querySelector("parsererror")) throw new Error("The .docx document XML is invalid");
  const stylesDom = stylesXml ? parser.parseFromString(stylesXml, "application/xml") : null;
  const relationshipsDom = relationshipsXml ? parser.parseFromString(relationshipsXml, "application/xml") : null;
  const styles = readStyles(stylesDom);
  const documentDefaults = descendant(stylesDom?.documentElement, "docDefaults");
  const defaultParagraph = readParagraphProperties(child(child(documentDefaults, "pPrDefault"), "pPr"));
  const defaultRun = readRunProperties(child(child(documentDefaults, "rPrDefault"), "rPr"));
  const relationships = new Map<string, string>();
  descendants(relationshipsDom?.documentElement, "Relationship").forEach((relationship) => {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id && target) relationships.set(id, target);
  });
  const media = await readMedia(zip, relationships);
  const context: ConversionContext = { styles, defaultParagraph, defaultRun, relationships, media };
  const body = descendant(documentDom.documentElement, "body");
  if (!body) throw new Error("The .docx document body is empty");
  const blocks = Array.from(body.children).flatMap((element) => {
    if (element.localName === "p") return [paragraphToHtml(element, context)];
    if (element.localName === "tbl") return [tableToHtml(element, context)];
    return [];
  });
  const html = blocks.join("") || "<p><br></p>";
  const plainDocument = parser.parseFromString(`<body>${html}</body>`, "text/html");
  const plainText = (plainDocument.body.innerText || plainDocument.body.textContent || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const warnings: string[] = [];
  if (["ins", "del", "moveFrom", "moveTo"].some((name) => descendant(documentDom.documentElement, name))) warnings.push("Tracked changes were flattened into the editable document.");
  if (["footnoteReference", "endnoteReference"].some((name) => descendant(documentDom.documentElement, name))) warnings.push("Footnotes or endnotes are not editable yet.");
  if (["chart", "object", "oleObject", "smartTag"].some((name) => descendant(documentDom.documentElement, name))) warnings.push("Some embedded objects are not editable.");
  return { html, plainText, page: pageSettings(documentDom), warnings };
}

interface ConversionContext {
  styles: Map<string, StyleDefinition>;
  defaultParagraph: Format;
  defaultRun: Format;
  relationships: Map<string, string>;
  media: Map<string, string>;
}

function paragraphToHtml(paragraph: Element, context: ConversionContext): string {
  const properties = child(paragraph, "pPr");
  const styleId = value(child(properties, "pStyle"));
  const style = resolveStyle(styleId, context.styles);
  const paragraphFormat = { ...context.defaultParagraph, ...style.paragraph, ...readParagraphProperties(properties) };
  const inheritedRun = { ...context.defaultRun, ...style.run, ...readRunProperties(child(properties, "rPr")) };
  const contents = Array.from(paragraph.children).flatMap((element) => inlineElementToHtml(element, context, inheritedRun)).join("");
  const tag = paragraphTag(style.name);
  const css = paragraphCss(paragraphFormat);
  return `<${tag}${css ? ` style="${escapeAttribute(css)}"` : ""}>${contents || "<br>"}</${tag}>`;
}

function inlineElementToHtml(element: Element, context: ConversionContext, inheritedRun: Format): string[] {
  if (element.localName === "r") return [runToHtml(element, context, inheritedRun)];
  if (element.localName === "hyperlink") {
    const relationshipId = attribute(element, "id");
    const href = context.relationships.get(relationshipId) || "";
    const content = Array.from(element.children).flatMap((childElement) => inlineElementToHtml(childElement, context, inheritedRun)).join("");
    return href ? [`<a href="${escapeAttribute(href)}">${content}</a>`] : [content];
  }
  if (["ins", "smartTag", "sdt", "sdtContent", "fldSimple"].includes(element.localName)) {
    return Array.from(element.children).flatMap((childElement) => inlineElementToHtml(childElement, context, inheritedRun));
  }
  if (["del", "moveFrom"].includes(element.localName)) return [];
  return [];
}

function runToHtml(run: Element, context: ConversionContext, inheritedRun: Format): string {
  const properties = child(run, "rPr");
  const runStyleId = value(child(properties, "rStyle"));
  const runStyle = resolveStyle(runStyleId, context.styles);
  const format = { ...inheritedRun, ...runStyle.run, ...readRunProperties(properties) };
  const content = Array.from(run.children).flatMap((element) => {
    if (element.localName === "t" || element.localName === "delText" || element.localName === "instrText") {
      return [preserveText(element.textContent || "", attribute(element, "space") === "preserve")];
    }
    if (element.localName === "tab") return ["&emsp;"];
    if (element.localName === "br" || element.localName === "cr") return ["<br>"];
    if (element.localName === "noBreakHyphen") return ["&#8209;"];
    if (element.localName === "softHyphen") return ["&shy;"];
    if (element.localName === "drawing" || element.localName === "pict") return [drawingToHtml(element, context)];
    return [];
  }).join("");
  if (!content) return "";
  const css = runCss(format);
  return css ? `<span style="${escapeAttribute(css)}">${content}</span>` : content;
}

function drawingToHtml(drawing: Element, context: ConversionContext): string {
  const blip = descendant(drawing, "blip");
  const relationshipId = attribute(blip || undefined, "embed");
  const src = context.media.get(relationshipId);
  if (!src) return "";
  const extent = descendant(drawing, "extent");
  const width = Number(extent?.getAttribute("cx") || 0) / 9_525;
  const height = Number(extent?.getAttribute("cy") || 0) / 9_525;
  const docProperties = descendant(drawing, "docPr");
  const alt = docProperties?.getAttribute("descr") || docProperties?.getAttribute("name") || "Picture";
  const size = width && height ? ` style="width:${Math.round(width)}px;height:${Math.round(height)}px"` : "";
  return `<img src="${src}" alt="${escapeAttribute(alt)}"${size}>`;
}

function tableToHtml(table: Element, context: ConversionContext): string {
  const rows = directChildren(table, "tr").map((row, rowIndex) => {
    const cells = directChildren(row, "tc").map((cell) => {
      const contents = Array.from(cell.children).flatMap((element) => {
        if (element.localName === "p") return [paragraphToHtml(element, context)];
        if (element.localName === "tbl") return [tableToHtml(element, context)];
        return [];
      }).join("");
      const cellProperties = child(cell, "tcPr");
      const span = Number(value(child(cellProperties, "gridSpan")) || 1);
      const tag = rowIndex === 0 && toggle(child(child(row, "trPr"), "tblHeader")) ? "th" : "td";
      return `<${tag}${span > 1 ? ` colspan="${span}"` : ""}>${contents || "<p><br></p>"}</${tag}>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><tbody>${rows}</tbody></table>`;
}

function readStyles(stylesDom: Document | null): Map<string, StyleDefinition> {
  const styles = new Map<string, StyleDefinition>();
  descendants(stylesDom?.documentElement, "style").forEach((style) => {
    if (!attribute(style, "styleId")) return;
    styles.set(attribute(style, "styleId"), {
      id: attribute(style, "styleId"),
      name: value(child(style, "name")),
      basedOn: value(child(style, "basedOn")),
      paragraph: readParagraphProperties(child(style, "pPr")),
      run: readRunProperties(child(style, "rPr")),
    });
  });
  return styles;
}

function resolveStyle(id: string, styles: Map<string, StyleDefinition>, visited = new Set<string>()): StyleDefinition {
  const current = styles.get(id);
  if (!current || visited.has(id)) return { id: "", name: "", basedOn: "", paragraph: {}, run: {} };
  visited.add(id);
  const base = resolveStyle(current.basedOn, styles, visited);
  return { ...current, name: current.name || base.name, paragraph: { ...base.paragraph, ...current.paragraph }, run: { ...base.run, ...current.run } };
}

function readParagraphProperties(properties: Element | undefined): Format {
  if (!properties) return {};
  const spacing = child(properties, "spacing");
  const indent = child(properties, "ind");
  const shading = child(properties, "shd");
  const lineRule = attribute(spacing, "lineRule");
  const line = numberAttribute(spacing, "line");
  return compact({
    align: value(child(properties, "jc")),
    marginTop: twips(numberAttribute(spacing, "before")),
    marginBottom: twips(numberAttribute(spacing, "after")),
    lineHeight: line ? (lineRule === "exact" || lineRule === "atLeast" ? `${twips(line)}px` : String(line / 240)) : undefined,
    leftIndent: twips(numberAttribute(indent, "left") || numberAttribute(indent, "start")),
    rightIndent: twips(numberAttribute(indent, "right") || numberAttribute(indent, "end")),
    firstLine: twips(numberAttribute(indent, "firstLine")),
    hanging: twips(numberAttribute(indent, "hanging")),
    keepNext: toggle(child(properties, "keepNext")),
    pageBreakBefore: toggle(child(properties, "pageBreakBefore")),
    background: wordColor(attribute(shading, "fill")),
  });
}

function readRunProperties(properties: Element | undefined): Format {
  if (!properties) return {};
  const fonts = child(properties, "rFonts");
  const color = child(properties, "color");
  const shading = child(properties, "shd");
  const highlight = value(child(properties, "highlight"));
  const verticalAlign = value(child(properties, "vertAlign"));
  return compact({
    bold: toggle(child(properties, "b")),
    italic: toggle(child(properties, "i")),
    underline: child(properties, "u") ? value(child(properties, "u")) !== "none" : undefined,
    strike: toggle(child(properties, "strike")) || toggle(child(properties, "dstrike")),
    fontFamily: attribute(fonts, "ascii") || attribute(fonts, "hAnsi") || undefined,
    fontSize: numberValue(child(properties, "sz")) ? `${numberValue(child(properties, "sz")) / 2}pt` : undefined,
    color: wordColor(value(color)),
    background: HIGHLIGHTS[highlight] || wordColor(attribute(shading, "fill")),
    subscript: verticalAlign === "subscript",
    superscript: verticalAlign === "superscript",
    hidden: toggle(child(properties, "vanish")),
    allCaps: toggle(child(properties, "caps")),
    smallCaps: toggle(child(properties, "smallCaps")),
  });
}

function paragraphCss(format: Format): string {
  const css: string[] = [];
  if (format.align) css.push(`text-align:${format.align === "both" ? "justify" : format.align}`);
  const top = number(format.marginTop);
  const bottom = number(format.marginBottom);
  if (top !== undefined || bottom !== undefined) css.push(`margin:${top || 0}px 0 ${bottom || 0}px`);
  if (format.lineHeight) css.push(`line-height:${format.lineHeight}`);
  if (number(format.leftIndent)) css.push(`margin-left:${number(format.leftIndent)}px`);
  if (number(format.rightIndent)) css.push(`margin-right:${number(format.rightIndent)}px`);
  const textIndent = number(format.firstLine) || (number(format.hanging) ? -number(format.hanging)! : undefined);
  if (textIndent) css.push(`text-indent:${textIndent}px`);
  if (format.keepNext) css.push("break-after:avoid-page");
  if (format.pageBreakBefore) css.push("break-before:page");
  if (format.background) css.push(`background-color:${format.background}`);
  return css.join(";");
}

function runCss(format: Format): string {
  const css: string[] = [];
  if (format.hidden) css.push("display:none");
  if (format.bold) css.push("font-weight:700");
  if (format.italic) css.push("font-style:italic");
  const decorations = [...(format.underline ? ["underline"] : []), ...(format.strike ? ["line-through"] : [])];
  if (decorations.length) css.push(`text-decoration:${decorations.join(" ")}`);
  if (format.fontFamily) css.push(`font-family:${String(format.fontFamily).replace(/["']/g, "")},Arial,sans-serif`);
  if (format.fontSize) css.push(`font-size:${format.fontSize}`);
  if (format.color) css.push(`color:${format.color}`);
  if (format.background) css.push(`background-color:${format.background}`);
  if (format.subscript) css.push("vertical-align:sub;font-size:75%");
  if (format.superscript) css.push("vertical-align:super;font-size:75%");
  if (format.allCaps) css.push("text-transform:uppercase");
  if (format.smallCaps) css.push("font-variant:small-caps");
  return css.join(";");
}

function paragraphTag(styleName: string): "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  if (/^title$/i.test(styleName)) return "h1";
  const heading = /heading\s*([1-6])/i.exec(styleName);
  return heading ? (`h${heading[1]}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6") : "p";
}

function pageSettings(documentDom: Document): DocumentPageSettings {
  const section = descendant(documentDom.documentElement, "sectPr");
  const pageSize = child(section || undefined, "pgSz");
  const pageMargins = child(section || undefined, "pgMar");
  const rawWidth = numberAttribute(pageSize, "w") || 12_240;
  const rawHeight = numberAttribute(pageSize, "h") || 15_840;
  const orientation = attribute(pageSize, "orient") === "landscape" || rawWidth > rawHeight ? "landscape" : "portrait";
  const shortSide = Math.min(rawWidth, rawHeight);
  const longSide = Math.max(rawWidth, rawHeight);
  const size = Math.abs(shortSide - 11_906) < 220 && Math.abs(longSide - 16_838) < 220 ? "a4" : "letter";
  const horizontalMargin = Math.max(numberAttribute(pageMargins, "left"), numberAttribute(pageMargins, "right"));
  const margins = horizontalMargin <= 900 ? "narrow" : horizontalMargin >= 2_000 ? "wide" : "normal";
  return { size, orientation, margins };
}

async function readMedia(zip: JSZip, relationships: Map<string, string>): Promise<Map<string, string>> {
  const media = new Map<string, string>();
  await Promise.all(Array.from(relationships.entries()).map(async ([id, target]) => {
    if (!target.startsWith("media/")) return;
    const entry = zip.file(`word/${target}`);
    if (!entry) return;
    const extension = target.split(".").pop()?.toLowerCase() || "png";
    const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : extension === "webp" ? "image/webp" : extension === "svg" ? "image/svg+xml" : "image/png";
    media.set(id, `data:${mime};base64,${await entry.async("base64")}`);
  }));
  return media;
}

function child(parent: Element | undefined, localName: string): Element | undefined {
  return parent ? Array.from(parent.children).find((element) => element.localName === localName) : undefined;
}

function directChildren(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((element) => element.localName === localName);
}

function descendant(parent: Element | undefined, localName: string): Element | undefined {
  return parent ? Array.from(parent.getElementsByTagNameNS("*", localName))[0] : undefined;
}

function descendants(parent: Element | undefined, localName: string): Element[] {
  return parent ? Array.from(parent.getElementsByTagNameNS("*", localName)) : [];
}

function attribute(element: Element | undefined, localName: string): string {
  if (!element) return "";
  const direct = element.getAttribute(localName) || element.getAttribute(`w:${localName}`) || element.getAttribute(`r:${localName}`);
  if (direct) return direct;
  return Array.from(element.attributes).find((item) => item.localName === localName)?.value || "";
}

function value(element: Element | undefined): string { return attribute(element, "val"); }
function numberValue(element: Element | undefined): number { return Number(value(element)) || 0; }
function numberAttribute(element: Element | undefined, name: string): number { return Number(attribute(element, name)) || 0; }
function number(value: CSSValue): number | undefined { return typeof value === "number" ? value : undefined; }
function twips(value: number): number | undefined { return value ? Math.round(value * 96 / 1_440 * 100) / 100 : undefined; }
function toggle(element: Element | undefined): boolean | undefined { if (!element) return undefined; return !["0", "false", "off"].includes(value(element).toLowerCase()); }
function wordColor(value: string): string | undefined { return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : undefined; }
function compact(format: Format): Format { return Object.fromEntries(Object.entries(format).filter(([, value]) => value !== undefined && value !== "")); }
function preserveText(value: string, preserve: boolean): string {
  const escaped = escapeHtml(value);
  if (!preserve) return escaped;
  return escaped.replace(/ {2,}/g, (spaces) => `${"&nbsp;".repeat(spaces.length - 1)} `);
}
function escapeHtml(value: string): string { return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] || character); }
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/"/g, "&quot;"); }
