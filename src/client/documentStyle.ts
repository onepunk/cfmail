const SAFE_PROPERTIES = new Set([
  "background-color",
  "break-after",
  "break-before",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "vertical-align",
  "width",
]);

const LENGTH = "-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:px|pt|em|rem|%|in|cm|mm)?";
const LENGTH_VALUE = new RegExp(`^${LENGTH}$`, "i");
const BOX_VALUE = new RegExp(`^${LENGTH}(?:\\s+${LENGTH}){0,3}$`, "i");
const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|transparent|currentcolor)$/i;

export type DocumentStyleDeclaration = readonly [property: string, value: string];

export function parseDocumentStyle(value: string): DocumentStyleDeclaration[] {
  if (!value || value.length > 4_000) return [];
  const declarations: DocumentStyleDeclaration[] = [];
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!SAFE_PROPERTIES.has(property) || !safeValue(property, propertyValue)) continue;
    declarations.push([property, propertyValue]);
  }
  return declarations;
}

export function serializeDocumentStyle(value: string): string {
  return parseDocumentStyle(value).map(([property, propertyValue]) => `${property}:${propertyValue}`).join(";");
}

export function hydrateDocumentStyles(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const declarations = parseDocumentStyle(element.getAttribute("style") || "");
    element.removeAttribute("style");
    declarations.forEach(([property, propertyValue]) => element.style.setProperty(property, propertyValue));
  });
}

function safeValue(property: string, value: string): boolean {
  if (!value || value.length > 180 || /[{}@\\]|!important|expression|url\s*\(|var\s*\(/i.test(value)) return false;
  if (property === "color" || property === "background-color") return COLOR_VALUE.test(value);
  if (["margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "text-indent"].includes(property)) return property === "margin" ? BOX_VALUE.test(value) : LENGTH_VALUE.test(value);
  if (["font-size", "width", "height"].includes(property)) return LENGTH_VALUE.test(value) || value.toLowerCase() === "auto";
  if (property === "line-height") return LENGTH_VALUE.test(value) || /^(?:normal|\d+(?:\.\d+)?)$/i.test(value);
  if (property === "font-family") return /^[\p{L}\p{N}\s,'"-]+$/u.test(value);
  if (property === "font-weight") return /^(?:normal|bold|[1-9]00)$/i.test(value);
  if (property === "font-style") return /^(?:normal|italic|oblique)$/i.test(value);
  if (property === "font-variant") return /^(?:normal|small-caps)$/i.test(value);
  if (property === "text-align") return /^(?:start|end|left|right|center|justify)$/i.test(value);
  if (property === "text-decoration") return /^(?:none|underline|line-through)(?:\s+(?:underline|line-through))*$/i.test(value);
  if (property === "text-transform") return /^(?:none|uppercase|lowercase|capitalize)$/i.test(value);
  if (property === "vertical-align") return /^(?:baseline|sub|super|top|middle|bottom)$/i.test(value);
  if (property === "display") return /^(?:none|inline|inline-block|block)$/i.test(value);
  if (property === "break-after") return /^(?:auto|avoid|avoid-page|page)$/i.test(value);
  if (property === "break-before") return /^(?:auto|avoid|page)$/i.test(value);
  return false;
}
